import { PREVIEW_CONTRACT_VERSION } from "../../types/analysis"
import type {
  BuildPlan,
  CreatePreviewJobRequest,
  PreviewJob,
  PreviewJobErrorCode,
  PreviewJobStatus,
  PreviewRequester,
  PreviewRepositoryRef,
} from "../../types/preview"
import {
  InvalidBuildPlanError,
  createBuildCacheKey,
  validateBuildPlan,
  validateRepositoryRef,
} from "../../core/preview/buildPlan"
import { PreviewControlError } from "./errors"
import type {
  PreviewArtifactCache,
  PreviewArtifactSigner,
  PreviewJobStore,
  PreviewPlanResolver,
  PreviewQueue,
  PreviewQuota,
  StoredPreviewJob,
} from "./ports"

const ACTIVE_STATUSES = new Set<PreviewJobStatus>([
  "queued",
  "fetching",
  "installing",
  "building",
  "publishing",
])

const TERMINAL_STATUSES = new Set<PreviewJobStatus>([
  "ready",
  "failed",
  "cancelled",
])

const NEXT_PHASES = new Map<PreviewJobStatus, Set<PreviewJobStatus>>([
  ["queued", new Set(["fetching"])],
  ["fetching", new Set(["installing", "building", "publishing"])],
  ["installing", new Set(["building"])],
  ["building", new Set(["publishing"])],
])

const SAFE_ERROR_MESSAGES: Record<PreviewJobErrorCode, string> = {
  FETCH_FAILED: "The repository source could not be fetched.",
  INSTALL_FAILED: "Dependencies could not be installed.",
  BUILD_FAILED: "The static build did not complete successfully.",
  PUBLISH_FAILED: "The static output could not be published.",
  RUNNER_TIMEOUT: "The preview job exceeded its time limit.",
  RUNNER_UNAVAILABLE: "No preview runner was available.",
  ARTIFACT_UNAVAILABLE: "The preview artifact is unavailable.",
}

export interface PreviewControlPlaneOptions {
  runnerVersion: string
  jobTimeoutMs?: number
  artifactTtlMs?: number
  now?: () => Date
  createId?: () => string
}

export interface CreatePreviewJobResult {
  created: boolean
  job: PreviewJob
}

export class PreviewControlPlane {
  private readonly jobTimeoutMs: number
  private readonly artifactTtlMs: number
  private readonly now: () => Date
  private readonly createId: () => string

  constructor(
    private readonly planResolver: PreviewPlanResolver,
    private readonly store: PreviewJobStore,
    private readonly queue: PreviewQueue,
    private readonly artifactCache: PreviewArtifactCache,
    private readonly artifactSigner: PreviewArtifactSigner,
    private readonly quota: PreviewQuota,
    private readonly options: PreviewControlPlaneOptions,
  ) {
    this.jobTimeoutMs = options.jobTimeoutMs ?? 15 * 60_000
    this.artifactTtlMs = options.artifactTtlMs ?? 60 * 60_000
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? (() => crypto.randomUUID())

    if (!/^[a-z\d._-]{1,64}$/i.test(options.runnerVersion)) {
      throw new Error("Runner version is invalid.")
    }
  }

  async create(
    request: CreatePreviewJobRequest,
    idempotencyKey: string,
    requester: PreviewRequester,
  ): Promise<CreatePreviewJobResult> {
    validateCreateInput(request, idempotencyKey, requester)
    const requestFingerprint = await createRequestFingerprint(request)
    const existing = await this.store.getByIdempotencyKey(
      requester.subject,
      idempotencyKey,
    )

    if (existing) {
      assertSameIdempotentRequest(
        existing.requestFingerprint,
        requestFingerprint,
      )
      return {
        created: false,
        job: toPublicJob(await this.refreshExpiry(existing.job)),
      }
    }

    const now = this.now()
    const quota = await this.quota.consume(requester, request.repository, now)

    if (!quota.allowed) {
      throw new PreviewControlError(
        "RATE_LIMITED",
        "Preview job quota exceeded. Try again later.",
        429,
        quota.retryAfterSeconds,
      )
    }

    const resolvedPlan = await this.planResolver.resolve(
      structuredClone(request.repository),
      request.contractVersion,
    )

    if (!resolvedPlan) {
      throw new PreviewControlError(
        "UNSUPPORTED_REPOSITORY",
        "This repository does not satisfy the native preview contract.",
        422,
      )
    }

    const plan = validateResolvedPlan(resolvedPlan, request)
    const cacheKey = await createBuildCacheKey(plan, this.options.runnerVersion)
    const cachedArtifact = await this.artifactCache.get(cacheKey, now)
    const id = this.createId()
    const initialExpiry = new Date(now.getTime() + this.jobTimeoutMs)
    let job: StoredPreviewJob = {
      id,
      requesterId: requester.subject,
      repository: structuredClone(request.repository),
      plan,
      cacheKey,
      cacheStatus: cachedArtifact ? "hit" : "miss",
      status: cachedArtifact ? "ready" : "queued",
      artifact: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: initialExpiry.toISOString(),
    }

    if (cachedArtifact) {
      const expiresAt = earlierDate(
        cachedArtifact.expiresAt,
        new Date(now.getTime() + this.artifactTtlMs),
      )
      job = {
        ...job,
        artifact: await this.artifactSigner.sign(
          cachedArtifact.artifactId,
          id,
          expiresAt,
        ),
        expiresAt: expiresAt.toISOString(),
      }
    }

    const persisted = await this.store.createOrGet({
      requesterId: requester.subject,
      idempotencyKey,
      requestFingerprint,
      job,
    })

    if (persisted.created && persisted.job.status === "queued") {
      try {
        await this.queue.enqueue({
          jobId: persisted.job.id,
          repository: persisted.job.repository,
          plan: persisted.job.plan,
          cacheKey: persisted.job.cacheKey,
        })
      } catch {
        const failed = await this.fail(persisted.job.id, "RUNNER_UNAVAILABLE")
        return { created: true, job: failed }
      }
    }

    return { created: persisted.created, job: toPublicJob(persisted.job) }
  }

  async get(jobId: string, requester: PreviewRequester): Promise<PreviewJob> {
    validateRequester(requester)
    const job = await this.getOwnedJob(jobId, requester.subject)
    return toPublicJob(await this.refreshExpiry(job))
  }

  async cancel(
    jobId: string,
    requester: PreviewRequester,
  ): Promise<PreviewJob> {
    validateRequester(requester)
    const current = await this.getOwnedJob(jobId, requester.subject)
    const refreshed = await this.refreshExpiry(current)

    if (refreshed.status === "cancelled") {
      return toPublicJob(refreshed)
    }

    if (!ACTIVE_STATUSES.has(refreshed.status)) {
      throw new PreviewControlError(
        "CONFLICT",
        `A ${refreshed.status} preview job cannot be cancelled.`,
        409,
      )
    }

    const updated = await this.store.update(jobId, (job) => {
      assertActive(job)
      return transition(job, "cancelled", this.now())
    })
    await this.queue.cancel(jobId).catch(() => undefined)
    return toPublicJob(updated)
  }

  async markPhase(
    jobId: string,
    status: "fetching" | "installing" | "building" | "publishing",
  ): Promise<PreviewJob> {
    const updated = await this.store.update(jobId, (job) => {
      const allowed = NEXT_PHASES.get(job.status)

      if (!allowed?.has(status)) {
        throw invalidTransition(job.status, status)
      }

      return transition(job, status, this.now())
    })

    return toPublicJob(updated)
  }

  async fail(
    jobId: string,
    errorCode: PreviewJobErrorCode,
  ): Promise<PreviewJob> {
    const updated = await this.store.update(jobId, (job) => {
      assertActive(job)
      return {
        ...transition(job, "failed", this.now()),
        errorCode,
        errorMessage: SAFE_ERROR_MESSAGES[errorCode],
      }
    })

    return toPublicJob(updated)
  }

  async complete(jobId: string, artifactId: string): Promise<PreviewJob> {
    const now = this.now()
    const expiresAt = new Date(now.getTime() + this.artifactTtlMs)
    const current = await this.store.get(jobId)

    if (!current) {
      throw new PreviewControlError("NOT_FOUND", "Preview job not found.", 404)
    }

    if (current.status !== "publishing") {
      throw invalidTransition(current.status, "ready")
    }

    const artifact = await this.artifactSigner.sign(
      artifactId,
      current.id,
      expiresAt,
    )
    const updated = await this.store.update(jobId, (job) => {
      if (job.status !== "publishing") {
        throw invalidTransition(job.status, "ready")
      }

      return {
        ...transition(job, "ready", now),
        artifact,
        expiresAt: expiresAt.toISOString(),
      }
    })
    await this.artifactCache.put(current.cacheKey, artifactId, expiresAt)

    return toPublicJob(updated)
  }

  private async getOwnedJob(
    jobId: string,
    requesterId: string,
  ): Promise<StoredPreviewJob> {
    if (!/^[a-z\d-]{8,64}$/i.test(jobId)) {
      throw new PreviewControlError("NOT_FOUND", "Preview job not found.", 404)
    }

    const job = await this.store.get(jobId)

    if (!job) {
      throw new PreviewControlError("NOT_FOUND", "Preview job not found.", 404)
    }

    if (job.requesterId !== requesterId) {
      throw new PreviewControlError("NOT_FOUND", "Preview job not found.", 404)
    }

    return job
  }

  private async refreshExpiry(
    job: StoredPreviewJob,
  ): Promise<StoredPreviewJob> {
    if (new Date(job.expiresAt).getTime() > this.now().getTime()) {
      return job
    }

    if (job.status === "expired") {
      return job
    }

    return this.store.update(job.id, (current) => {
      if (current.status === "expired") {
        return current
      }

      if (ACTIVE_STATUSES.has(current.status)) {
        return {
          ...transition(current, "failed", this.now()),
          errorCode: "RUNNER_TIMEOUT",
          errorMessage: SAFE_ERROR_MESSAGES.RUNNER_TIMEOUT,
        }
      }

      if (TERMINAL_STATUSES.has(current.status)) {
        return {
          ...transition(current, "expired", this.now()),
          artifact: null,
        }
      }

      return current
    })
  }
}

function validateCreateInput(
  request: CreatePreviewJobRequest,
  idempotencyKey: string,
  requester: PreviewRequester,
): void {
  validateRequester(requester)

  if (!/^[\x21-\x7e]{16,128}$/.test(idempotencyKey)) {
    throw new PreviewControlError(
      "INVALID_REQUEST",
      "Idempotency-Key must contain 16 to 128 visible ASCII characters.",
      400,
    )
  }

  try {
    validateRepositoryRef(request.repository)
  } catch (error) {
    throw asInvalidRequest(error)
  }

  if (request.contractVersion !== PREVIEW_CONTRACT_VERSION) {
    throw new PreviewControlError(
      "INVALID_REQUEST",
      "Unsupported preview contract version.",
      400,
    )
  }
}

function validateRequester(requester: PreviewRequester): void {
  if (
    !requester.subject ||
    requester.subject.length > 128 ||
    !requester.ip ||
    requester.ip.length > 64
  ) {
    throw new PreviewControlError(
      "INVALID_REQUEST",
      "A valid preview requester is required.",
      400,
    )
  }
}

function validateResolvedPlan(
  value: BuildPlan,
  request: CreatePreviewJobRequest,
): BuildPlan {
  let plan: BuildPlan

  try {
    plan = validateBuildPlan(value)
  } catch (error) {
    if (error instanceof InvalidBuildPlanError) {
      throw new PreviewControlError(
        "UNSUPPORTED_REPOSITORY",
        "The server could not derive a safe static build plan.",
        422,
      )
    }

    throw error
  }

  if (
    plan.contractVersion !== request.contractVersion ||
    !sameRepository(plan.repository, request.repository)
  ) {
    throw new PreviewControlError(
      "CONFLICT",
      "Resolved repository identity does not match the requested commit.",
      409,
    )
  }

  return plan
}

async function createRequestFingerprint(
  request: CreatePreviewJobRequest,
): Promise<string> {
  const canonical = JSON.stringify({
    repositoryId: request.repository.repositoryId,
    owner: request.repository.owner.toLowerCase(),
    name: request.repository.name.toLowerCase(),
    commitSha: request.repository.commitSha.toLowerCase(),
    contractVersion: request.contractVersion,
  })
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  )

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")
}

function assertSameIdempotentRequest(
  existingFingerprint: string,
  requestFingerprint: string,
): void {
  if (existingFingerprint !== requestFingerprint) {
    throw new PreviewControlError(
      "CONFLICT",
      "The idempotency key was already used for a different request.",
      409,
    )
  }
}

function assertActive(job: StoredPreviewJob): void {
  if (!ACTIVE_STATUSES.has(job.status)) {
    throw invalidTransition(job.status, "failed")
  }
}

function transition(
  job: StoredPreviewJob,
  status: PreviewJobStatus,
  now: Date,
): StoredPreviewJob {
  return {
    ...job,
    status,
    updatedAt: now.toISOString(),
  }
}

function invalidTransition(
  from: PreviewJobStatus,
  to: PreviewJobStatus,
): PreviewControlError {
  return new PreviewControlError(
    "INVALID_TRANSITION",
    `Preview job cannot transition from ${from} to ${to}.`,
    409,
  )
}

function sameRepository(
  left: PreviewRepositoryRef,
  right: PreviewRepositoryRef,
): boolean {
  return (
    left.repositoryId === right.repositoryId &&
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase() &&
    left.commitSha.toLowerCase() === right.commitSha.toLowerCase()
  )
}

function toPublicJob(job: StoredPreviewJob): PreviewJob {
  const publicJob: PreviewJob = {
    id: job.id,
    repository: job.repository,
    plan: job.plan,
    cacheKey: job.cacheKey,
    cacheStatus: job.cacheStatus,
    status: job.status,
    artifact: job.artifact,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
  }
  return structuredClone(publicJob)
}

function earlierDate(left: Date, right: Date): Date {
  return left.getTime() <= right.getTime() ? left : right
}

function asInvalidRequest(error: unknown): PreviewControlError {
  return new PreviewControlError(
    "INVALID_REQUEST",
    error instanceof InvalidBuildPlanError
      ? error.message
      : "Preview job request is invalid.",
    400,
  )
}
