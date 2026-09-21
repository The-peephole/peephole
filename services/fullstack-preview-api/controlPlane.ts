import { PREVIEW_CONTRACT_VERSION } from "../../types/analysis"
import type { BuildPlan, PreviewRepositoryRef } from "../../types/preview"
import type { BackendRuntimePlan } from "../../types/backendRuntime"
import {
  FULLSTACK_PREVIEW_CONTRACT_VERSION,
  type CreateFullStackPreviewRequest,
  type FullStackPreview,
  type FullStackPreviewErrorCode,
  type FullStackPreviewStatus,
} from "../../types/fullstackPreview"
import { validateBuildPlan } from "../../core/preview/buildAdapters"
import {
  InvalidBuildPlanError,
  validateRepositoryRef,
} from "../../core/preview/buildPlan"
import {
  InvalidBackendRuntimePlanError,
  validateBackendRuntimePlan,
} from "../../core/preview/backendRuntimePlanValidator"
import { isSafePreviewSourceRoot } from "../../core/preview/sourceRoot"
import { FullStackPreviewControlError } from "./errors"
import { FULLSTACK_PREVIEW_ID_PATTERN, createFullStackPreviewId } from "./id"
import type {
  BackendPlanResolver,
  FrontendPlanResolver,
  FullStackPreviewQueue,
  FullStackPreviewStore,
  PreviewQuota,
  PreviewRequester,
  StoredFullStackPreview,
} from "./ports"

/** Everything except a final resting state. `ready` remains reserved for the
 * later routing activation phase but already counts as active. */
const ACTIVE_STATUSES = new Set<FullStackPreviewStatus>([
  "queued",
  "building_frontend",
  "starting_backend",
  "awaiting_activation",
  "ready",
  "stopping",
])

/** Only states that have not completed both child provisioning steps time out
 * as provisioning failures. `awaiting_activation` expires normally. */
const PROVISIONING_STATUSES = new Set<FullStackPreviewStatus>([
  "queued",
  "building_frontend",
  "starting_backend",
])

const TERMINAL_STATUSES = new Set<FullStackPreviewStatus>([
  "stopped",
  "failed",
  "cancelled",
  "expired",
])

/** Teardown-only transitions. There is deliberately no Phase 2B path to
 * `ready`; provisioning uses the atomic child-recording methods. */
const NEXT_PHASES = new Map<
  FullStackPreviewStatus,
  Set<FullStackPreviewStatus>
>([
  ["ready", new Set(["stopping"])],
  ["stopping", new Set(["stopped"])],
])

const SAFE_ERROR_MESSAGES: Record<FullStackPreviewErrorCode, string> = {
  UNSUPPORTED_FRONTEND:
    "This repository's frontend does not satisfy the full-stack preview contract.",
  UNSUPPORTED_BACKEND:
    "This repository's backend does not satisfy the full-stack preview contract.",
  FRONTEND_FAILED: "The full-stack preview frontend could not be prepared.",
  BACKEND_FAILED: "The full-stack preview backend could not be started.",
  PROVISIONING_TIMEOUT:
    "The full-stack preview did not finish provisioning in time.",
  ORCHESTRATION_UNAVAILABLE:
    "No full-stack preview orchestration worker was available.",
}

export interface FullStackPreviewControlPlaneOptions {
  /** Bounded *provisioning* deadline only -- not yet the final full-stack
   * origin lifetime. Once a future phase's activation exists, a `ready`
   * preview's own expiry must be tightened to
   * `min(backendRuntime.expiresAt, underlying artifact authorization expiry)`
   * -- see D-031. Default 15 minutes, matching
   * `PreviewControlPlane`'s own `jobTimeoutMs` default: a full-stack
   * preview's provisioning phase does strictly more work (a frontend build
   * *and* a backend start) than either existing pipeline alone. */
  provisioningTtlMs?: number
  /** Default 1 -- mirrors `BackendRuntimeControlPlane`'s own default, for
   * the same reason: the current production host is small, and a
   * full-stack preview always implies at least one backend runtime. */
  maxActiveFullStackPreviewsPerRequester?: number
  now?: () => Date
  createId?: () => string
}

export interface CreateFullStackPreviewResult {
  created: boolean
  preview: FullStackPreview
}

/**
 * Fully separate from `PreviewControlPlane` and `BackendRuntimeControlPlane`
 * -- never merged into either. A `FullStackPreview` only ever *pairs*
 * identities those two control planes independently authorize. The separate
 * Phase 2B supervisor drives those children through private worker methods;
 * HTTP callers still see only this parent resource.
 */
export class FullStackPreviewControlPlane {
  private readonly provisioningTtlMs: number
  private readonly maxActiveFullStackPreviewsPerRequester: number
  private readonly now: () => Date
  private readonly createId: () => string

  constructor(
    private readonly frontendPlanResolver: FrontendPlanResolver,
    private readonly backendPlanResolver: BackendPlanResolver,
    private readonly store: FullStackPreviewStore,
    private readonly queue: FullStackPreviewQueue,
    private readonly admissionQuota: PreviewQuota,
    options: FullStackPreviewControlPlaneOptions = {},
  ) {
    this.provisioningTtlMs = options.provisioningTtlMs ?? 15 * 60_000
    this.maxActiveFullStackPreviewsPerRequester =
      options.maxActiveFullStackPreviewsPerRequester ?? 1
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? createFullStackPreviewId
  }

  async create(
    request: CreateFullStackPreviewRequest,
    idempotencyKey: string,
    requester: PreviewRequester,
  ): Promise<CreateFullStackPreviewResult> {
    validateRequester(requester)
    validateCreateInput(request, idempotencyKey)

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
        preview: toPublicPreview(await this.refreshExpiry(existing.preview)),
      }
    }

    const quota = await this.admissionQuota.consume(
      requester,
      request.repository,
      this.now(),
    )
    if (!quota.allowed) {
      throw new FullStackPreviewControlError(
        "RATE_LIMITED",
        "Preview job quota exceeded. Try again later.",
        429,
        quota.retryAfterSeconds,
      )
    }

    // Support validation only -- neither resolved plan is ever persisted or
    // used to create the underlying PreviewJob/BackendRuntime here. A
    // future worker phase independently re-resolves both again, exactly
    // like every other trust boundary in this codebase.
    await resolveFrontendPlan(this.frontendPlanResolver, request)
    await resolveBackendPlan(this.backendPlanResolver, request)

    const now = this.now()
    const id = this.createId()
    const expiresAt = new Date(now.getTime() + this.provisioningTtlMs)
    const preview: StoredFullStackPreview = {
      id,
      requesterId: requester.subject,
      requestFingerprint,
      repository: structuredClone(request.repository),
      frontendSourceRoot: request.frontendTarget.sourceRoot,
      backendSourceRoot: request.backendSourceRoot,
      status: "queued",
      url: null,
      frontendJobId: null,
      artifactId: null,
      backendRuntimeId: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    }

    const persisted = await this.store.createOrGetWithCapacity({
      requesterId: requester.subject,
      idempotencyKey,
      requestFingerprint,
      preview,
      maxActive: this.maxActiveFullStackPreviewsPerRequester,
    })

    if (
      persisted.created &&
      persisted.preview.status === "queued" &&
      !persisted.enqueued
    ) {
      try {
        await this.queue.enqueue({
          previewId: persisted.preview.id,
          repository: persisted.preview.repository,
          frontendSourceRoot: persisted.preview.frontendSourceRoot,
          backendSourceRoot: persisted.preview.backendSourceRoot,
        })
      } catch {
        const failed = await this.fail(
          persisted.preview.id,
          "ORCHESTRATION_UNAVAILABLE",
        )
        return { created: true, preview: failed }
      }
    }

    return {
      created: persisted.created,
      preview: toPublicPreview(persisted.preview),
    }
  }

  async get(
    previewId: string,
    requester: PreviewRequester,
  ): Promise<FullStackPreview> {
    validateRequester(requester)
    const preview = await this.getOwnedPreview(previewId, requester.subject)
    return toPublicPreview(await this.refreshExpiry(preview))
  }

  async cancel(
    previewId: string,
    requester: PreviewRequester,
  ): Promise<FullStackPreview> {
    validateRequester(requester)
    const current = await this.getOwnedPreview(previewId, requester.subject)
    const refreshed = await this.refreshExpiry(current)

    if (TERMINAL_STATUSES.has(refreshed.status)) {
      return toPublicPreview(refreshed)
    }

    const updated = await this.store.update(previewId, (preview) => {
      if (TERMINAL_STATUSES.has(preview.status)) return preview
      const target: FullStackPreviewStatus =
        preview.status === "ready" || preview.status === "stopping"
          ? "stopping"
          : "cancelled"
      return transition(preview, target, this.now())
    })
    await this.queue.cancel(previewId).catch(() => undefined)
    return toPublicPreview(updated)
  }

  /** Generic teardown transitions. Provisioning transitions use the narrow
   * child-recording operations below so identities and state move atomically. */
  async markPhase(
    previewId: string,
    status: "stopping" | "stopped",
  ): Promise<FullStackPreview> {
    const updated = await this.store.update(previewId, (preview) => {
      const allowed = NEXT_PHASES.get(preview.status)
      if (!allowed?.has(status)) throw invalidTransition(preview.status, status)
      return transition(preview, status, this.now())
    })
    return toPublicPreview(updated)
  }

  async recordFrontendJob(
    previewId: string,
    frontendJobId: string,
  ): Promise<void> {
    validateChildId(frontendJobId, "frontend job")
    await this.store.update(previewId, (preview) => {
      if (preview.status !== "building_frontend") {
        throw invalidTransition(preview.status, "building_frontend")
      }
      if (
        preview.frontendJobId !== null &&
        preview.frontendJobId !== frontendJobId
      ) {
        throw childIdentityConflict("frontend job")
      }
      return preview.frontendJobId === frontendJobId
        ? preview
        : {
            ...preview,
            frontendJobId,
            updatedAt: this.now().toISOString(),
          }
    })
  }

  async recordFrontendArtifact(
    previewId: string,
    input: {
      frontendJobId: string
      artifactId: string
      artifactExpiresAt: Date
    },
  ): Promise<void> {
    validateChildId(input.frontendJobId, "frontend job")
    validateChildId(input.artifactId, "frontend artifact")
    validateExpiry(input.artifactExpiresAt)
    await this.store.update(previewId, (preview) => {
      if (
        preview.status === "starting_backend" &&
        preview.frontendJobId === input.frontendJobId &&
        preview.artifactId === input.artifactId
      ) {
        return preview
      }
      if (preview.status !== "building_frontend") {
        throw invalidTransition(preview.status, "starting_backend")
      }
      if (preview.frontendJobId !== input.frontendJobId) {
        throw childIdentityConflict("frontend job")
      }
      if (
        preview.artifactId !== null &&
        preview.artifactId !== input.artifactId
      ) {
        throw childIdentityConflict("frontend artifact")
      }
      return {
        ...transition(preview, "starting_backend", this.now()),
        artifactId: input.artifactId,
        expiresAt: earlierIso(preview.expiresAt, input.artifactExpiresAt),
      }
    })
  }

  async recordBackendRuntime(
    previewId: string,
    backendRuntimeId: string,
  ): Promise<void> {
    validateChildId(backendRuntimeId, "backend runtime")
    await this.store.update(previewId, (preview) => {
      if (preview.status !== "starting_backend") {
        throw invalidTransition(preview.status, "starting_backend")
      }
      if (
        preview.backendRuntimeId !== null &&
        preview.backendRuntimeId !== backendRuntimeId
      ) {
        throw childIdentityConflict("backend runtime")
      }
      return preview.backendRuntimeId === backendRuntimeId
        ? preview
        : {
            ...preview,
            backendRuntimeId,
            updatedAt: this.now().toISOString(),
          }
    })
  }

  async markBackendRunning(
    previewId: string,
    input: { backendRuntimeId: string; backendExpiresAt: Date },
  ): Promise<void> {
    validateChildId(input.backendRuntimeId, "backend runtime")
    validateExpiry(input.backendExpiresAt)
    await this.store.update(previewId, (preview) => {
      if (
        preview.status === "awaiting_activation" &&
        preview.backendRuntimeId === input.backendRuntimeId &&
        preview.frontendJobId &&
        preview.artifactId
      ) {
        return preview
      }
      if (preview.status !== "starting_backend") {
        throw invalidTransition(preview.status, "awaiting_activation")
      }
      if (
        !preview.frontendJobId ||
        !preview.artifactId ||
        preview.backendRuntimeId !== input.backendRuntimeId
      ) {
        throw childIdentityConflict("provisioned child")
      }
      return {
        ...transition(preview, "awaiting_activation", this.now()),
        expiresAt: earlierIso(preview.expiresAt, input.backendExpiresAt),
      }
    })
  }

  /** Internal routing-plane operation. The caller derives the URL and child
   * expiries from authoritative server-side sources; this atomic update
   * rechecks that none of those identities changed before publishing it. */
  async activateRouting(
    previewId: string,
    input: {
      expectedArtifactId: string
      expectedBackendRuntimeId: string
      url: string
      expiresAt: Date
    },
  ): Promise<FullStackPreview> {
    validateChildId(input.expectedArtifactId, "frontend artifact")
    validateChildId(input.expectedBackendRuntimeId, "backend runtime")
    validateExpiry(input.expiresAt)
    validateReadyUrl(input.url)

    const updated = await this.store.update(previewId, (preview) => {
      const currentExpiry = new Date(preview.expiresAt)
      const proposedExpiry = input.expiresAt.getTime()

      if (preview.status === "ready") {
        if (
          preview.artifactId === input.expectedArtifactId &&
          preview.backendRuntimeId === input.expectedBackendRuntimeId &&
          preview.url === input.url &&
          currentExpiry.getTime() <= proposedExpiry
        ) {
          return preview
        }
        throw childIdentityConflict("routing activation")
      }

      if (preview.status !== "awaiting_activation") {
        throw invalidTransition(preview.status, "ready")
      }
      if (
        preview.artifactId !== input.expectedArtifactId ||
        preview.backendRuntimeId !== input.expectedBackendRuntimeId ||
        preview.frontendJobId === null ||
        preview.url !== null
      ) {
        throw childIdentityConflict("routing activation")
      }
      if (
        proposedExpiry <= this.now().getTime() ||
        proposedExpiry > currentExpiry.getTime()
      ) {
        throw new FullStackPreviewControlError(
          "INVALID_TRANSITION",
          "The routing activation expiry is invalid.",
          409,
        )
      }
      return {
        ...transition(preview, "ready", this.now()),
        url: input.url,
        expiresAt: input.expiresAt.toISOString(),
      }
    })
    return toPublicPreview(updated)
  }

  /** Worker-only authoritative read. Never exposed through HTTP. */
  async getWorkerFullStackPreview(
    previewId: string,
  ): Promise<StoredFullStackPreview | null> {
    const preview = await this.store.get(previewId)
    return preview ? this.refreshExpiry(preview) : null
  }

  /** Worker-only admission, mirroring `PreviewControlPlane.startWorkerJob`/
   * `BackendRuntimeControlPlane.startWorkerRuntime`. */
  async startWorkerFullStackPreview(
    previewId: string,
    recovered = false,
    abandon = false,
  ): Promise<boolean> {
    let started = false
    await this.store.update(previewId, (preview) => {
      if (!ACTIVE_STATUSES.has(preview.status)) return preview
      if (abandon || (recovered && preview.status !== "queued")) {
        return {
          ...transition(preview, "failed", this.now()),
          errorCode: "ORCHESTRATION_UNAVAILABLE",
          errorMessage: SAFE_ERROR_MESSAGES.ORCHESTRATION_UNAVAILABLE,
        }
      }
      if (preview.status !== "queued") return preview
      started = true
      return transition(preview, "building_frontend", this.now())
    })
    return started
  }

  async isWorkerFullStackPreviewActive(previewId: string): Promise<boolean> {
    const preview = await this.store.get(previewId)
    return (
      preview !== null &&
      ACTIVE_STATUSES.has((await this.refreshExpiry(preview)).status)
    )
  }

  async failWorkerFullStackPreview(
    previewId: string,
    code: FullStackPreviewErrorCode,
  ): Promise<void> {
    await this.store.update(previewId, (preview) =>
      ACTIVE_STATUSES.has(preview.status)
        ? {
            ...transition(preview, "failed", this.now()),
            errorCode: code,
            errorMessage: SAFE_ERROR_MESSAGES[code],
          }
        : preview,
    )
  }

  private async fail(
    previewId: string,
    errorCode: FullStackPreviewErrorCode,
  ): Promise<FullStackPreview> {
    const updated = await this.store.update(previewId, (preview) => ({
      ...transition(preview, "failed", this.now()),
      errorCode,
      errorMessage: SAFE_ERROR_MESSAGES[errorCode],
    }))
    return toPublicPreview(updated)
  }

  private async getOwnedPreview(
    previewId: string,
    requesterId: string,
  ): Promise<StoredFullStackPreview> {
    if (!FULLSTACK_PREVIEW_ID_PATTERN.test(previewId)) {
      throw new FullStackPreviewControlError(
        "NOT_FOUND",
        "Full-stack preview not found.",
        404,
      )
    }
    const preview = await this.store.get(previewId)
    if (!preview || preview.requesterId !== requesterId) {
      throw new FullStackPreviewControlError(
        "NOT_FOUND",
        "Full-stack preview not found.",
        404,
      )
    }
    return preview
  }

  private async refreshExpiry(
    preview: StoredFullStackPreview,
  ): Promise<StoredFullStackPreview> {
    if (new Date(preview.expiresAt).getTime() > this.now().getTime()) {
      return preview
    }
    if (TERMINAL_STATUSES.has(preview.status)) {
      return preview
    }
    return this.store.update(preview.id, (current) => {
      if (TERMINAL_STATUSES.has(current.status)) {
        return current
      }
      if (PROVISIONING_STATUSES.has(current.status)) {
        return {
          ...transition(current, "failed", this.now()),
          errorCode: "PROVISIONING_TIMEOUT",
          errorMessage: SAFE_ERROR_MESSAGES.PROVISIONING_TIMEOUT,
        }
      }
      // `awaiting_activation` has completed child provisioning, so expiry is
      // normal lifecycle expiry rather than a provisioning timeout. The same
      // applies to future "ready"/"stopping" states. Aging out here becomes
      // "expired", mirroring the static artifact/preview-job pattern.
      return transition(current, "expired", this.now())
    })
  }
}

function validateCreateInput(
  request: CreateFullStackPreviewRequest,
  idempotencyKey: string,
): void {
  if (!/^[\x21-\x7e]{16,128}$/.test(idempotencyKey)) {
    throw new FullStackPreviewControlError(
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

  if (request.contractVersion !== FULLSTACK_PREVIEW_CONTRACT_VERSION) {
    throw new FullStackPreviewControlError(
      "INVALID_REQUEST",
      "Unsupported full-stack preview contract version.",
      400,
    )
  }

  if (
    !request.frontendTarget ||
    !isSafePreviewSourceRoot(request.frontendTarget.sourceRoot)
  ) {
    throw new FullStackPreviewControlError(
      "INVALID_REQUEST",
      "The requested frontend source root is invalid.",
      400,
    )
  }

  if (!isSafePreviewSourceRoot(request.backendSourceRoot)) {
    throw new FullStackPreviewControlError(
      "INVALID_REQUEST",
      "The requested backend source root is invalid.",
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
    throw new FullStackPreviewControlError(
      "INVALID_REQUEST",
      "A valid full-stack preview requester is required.",
      400,
    )
  }
}

function validateChildId(value: string, label: string): void {
  if (!/^[a-z\d][a-z\d._:-]{0,127}$/i.test(value)) {
    throw new FullStackPreviewControlError(
      "INVALID_TRANSITION",
      `The recorded ${label} identity is invalid.`,
      409,
    )
  }
}

function validateExpiry(value: Date): void {
  if (!Number.isFinite(value.getTime())) {
    throw new FullStackPreviewControlError(
      "INVALID_TRANSITION",
      "The recorded child expiry is invalid.",
      409,
    )
  }
}

function validateReadyUrl(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw childIdentityConflict("routing URL")
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.toString() !== value
  ) {
    throw childIdentityConflict("routing URL")
  }
}

function childIdentityConflict(label: string): FullStackPreviewControlError {
  return new FullStackPreviewControlError(
    "INVALID_TRANSITION",
    `The stored ${label} identity does not match.`,
    409,
  )
}

function earlierIso(current: string, candidate: Date): string {
  const currentDate = new Date(current)
  return (
    currentDate.getTime() <= candidate.getTime() ? currentDate : candidate
  ).toISOString()
}

async function resolveFrontendPlan(
  resolver: FrontendPlanResolver,
  request: CreateFullStackPreviewRequest,
): Promise<BuildPlan> {
  const resolved = await resolver.resolve(
    structuredClone(request.repository),
    PREVIEW_CONTRACT_VERSION,
    { sourceRoot: request.frontendTarget.sourceRoot },
  )

  if (!resolved) {
    throw new FullStackPreviewControlError(
      "UNSUPPORTED_FRONTEND",
      SAFE_ERROR_MESSAGES.UNSUPPORTED_FRONTEND,
      422,
    )
  }

  let plan: BuildPlan
  try {
    plan = validateBuildPlan(resolved)
  } catch (error) {
    if (error instanceof InvalidBuildPlanError) {
      throw new FullStackPreviewControlError(
        "UNSUPPORTED_FRONTEND",
        "The server could not derive a safe static build plan for the requested frontend.",
        422,
      )
    }
    throw error
  }

  if (
    plan.contractVersion !== PREVIEW_CONTRACT_VERSION ||
    !sameRepository(plan.repository, request.repository) ||
    plan.sourceRoot !== request.frontendTarget.sourceRoot
  ) {
    throw new FullStackPreviewControlError(
      "CONFLICT",
      "Resolved frontend identity does not match the requested commit or source root.",
      409,
    )
  }

  return plan
}

async function resolveBackendPlan(
  resolver: BackendPlanResolver,
  request: CreateFullStackPreviewRequest,
): Promise<BackendRuntimePlan> {
  const resolved = await resolver.resolve(
    structuredClone(request.repository),
    request.backendSourceRoot,
  )

  if (!resolved) {
    throw new FullStackPreviewControlError(
      "UNSUPPORTED_BACKEND",
      SAFE_ERROR_MESSAGES.UNSUPPORTED_BACKEND,
      422,
    )
  }

  let plan: BackendRuntimePlan
  try {
    plan = validateBackendRuntimePlan(resolved)
  } catch (error) {
    if (error instanceof InvalidBackendRuntimePlanError) {
      throw new FullStackPreviewControlError(
        "UNSUPPORTED_BACKEND",
        "The server could not derive a safe backend runtime plan for the requested backend.",
        422,
      )
    }
    throw error
  }

  if (
    !sameRepository(plan.repository, request.repository) ||
    plan.sourceRoot !== request.backendSourceRoot
  ) {
    throw new FullStackPreviewControlError(
      "CONFLICT",
      "Resolved backend identity does not match the requested commit or source root.",
      409,
    )
  }

  return plan
}

async function createRequestFingerprint(
  request: CreateFullStackPreviewRequest,
): Promise<string> {
  const canonical = JSON.stringify({
    repositoryId: request.repository.repositoryId,
    owner: request.repository.owner.toLowerCase(),
    name: request.repository.name.toLowerCase(),
    commitSha: request.repository.commitSha.toLowerCase(),
    contractVersion: request.contractVersion,
    frontendSourceRoot: request.frontendTarget.sourceRoot,
    backendSourceRoot: request.backendSourceRoot,
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
    throw new FullStackPreviewControlError(
      "CONFLICT",
      "The idempotency key was already used for a different request.",
      409,
    )
  }
}

function transition(
  preview: StoredFullStackPreview,
  status: FullStackPreviewStatus,
  now: Date,
): StoredFullStackPreview {
  return { ...preview, status, updatedAt: now.toISOString() }
}

function invalidTransition(
  from: FullStackPreviewStatus,
  to: FullStackPreviewStatus,
): FullStackPreviewControlError {
  return new FullStackPreviewControlError(
    "INVALID_TRANSITION",
    `Full-stack preview cannot transition from ${from} to ${to}.`,
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

function toPublicPreview(preview: StoredFullStackPreview): FullStackPreview {
  return structuredClone({
    id: preview.id,
    repository: preview.repository,
    frontendSourceRoot: preview.frontendSourceRoot,
    backendSourceRoot: preview.backendSourceRoot,
    status: preview.status,
    url: preview.url,
    errorCode: preview.errorCode,
    errorMessage: preview.errorMessage,
    createdAt: preview.createdAt,
    updatedAt: preview.updatedAt,
    expiresAt: preview.expiresAt,
  } satisfies FullStackPreview)
}

function asInvalidRequest(error: unknown): FullStackPreviewControlError {
  return new FullStackPreviewControlError(
    "INVALID_REQUEST",
    error instanceof InvalidBuildPlanError
      ? error.message
      : "Full-stack preview request is invalid.",
    400,
  )
}
