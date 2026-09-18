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
  PreviewRequester,
  StoredFullStackPreview,
} from "./ports"

/** Everything except a final resting state -- including "ready"/"stopping",
 * which Phase 2A can never actually produce (no worker/activation exists
 * yet), but which must still count as active once a future phase can reach
 * them, so admission-cap counting and worker-liveness checks stay correct
 * without needing to change again when that phase lands. */
const ACTIVE_STATUSES = new Set<FullStackPreviewStatus>([
  "queued",
  "building_frontend",
  "starting_backend",
  "ready",
  "stopping",
])

/** The subset of ACTIVE_STATUSES Phase 2A's own provisioning TTL actually
 * governs -- "ready"/"stopping" are deliberately excluded: they represent a
 * live, already-activated preview, and their (future, tighter) expiry is a
 * distinct concept from "provisioning took too long" (see D-031). */
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

/** Worker-facing transitions that do not require additional activation
 * prerequisites. "starting_backend" -> "ready" is deliberately never
 * reachable through this map -- see `activateReady`. */
const NEXT_PHASES = new Map<
  FullStackPreviewStatus,
  Set<FullStackPreviewStatus>
>([
  ["building_frontend", new Set(["starting_backend"])],
  ["ready", new Set(["stopping"])],
  ["stopping", new Set(["stopped"])],
])

const SAFE_ERROR_MESSAGES: Record<FullStackPreviewErrorCode, string> = {
  UNSUPPORTED_FRONTEND:
    "This repository's frontend does not satisfy the full-stack preview contract.",
  UNSUPPORTED_BACKEND:
    "This repository's backend does not satisfy the full-stack preview contract.",
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
 * identities those two control planes independently authorize; this phase
 * (M9 Phase 2A) creates and validates that durable pairing but does not yet
 * drive either child resource's creation -- see the module-level "NOT
 * implemented" list in the accompanying PR description.
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

    const activeCount = await this.store.countActiveByRequester(
      requester.subject,
    )
    if (activeCount >= this.maxActiveFullStackPreviewsPerRequester) {
      throw new FullStackPreviewControlError(
        "RATE_LIMITED",
        "Only one active full-stack preview is allowed per requester at a time.",
        429,
        30,
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

    const persisted = await this.store.createOrGet({
      requesterId: requester.subject,
      idempotencyKey,
      requestFingerprint,
      preview,
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

  /** Generic worker phase transitions that need no additional resource
   * prerequisites. Deliberately excludes "ready", which is reachable only
   * through `activateReady`. */
  async markPhase(
    previewId: string,
    status: "starting_backend" | "stopping" | "stopped",
  ): Promise<FullStackPreview> {
    const updated = await this.store.update(previewId, (preview) => {
      const allowed = NEXT_PHASES.get(preview.status)
      if (!allowed?.has(status)) throw invalidTransition(preview.status, status)
      return transition(preview, status, this.now())
    })
    return toPublicPreview(updated)
  }

  /**
   * The dedicated, atomic "ready" activation a future worker phase will
   * call once both children exist. Deliberately re-reads and validates the
   * *stored* prerequisites itself rather than trusting caller-supplied
   * ids, so a preview can never become `ready` with a null frontend
   * artifact or backend runtime -- see D-031's "ready activation must be a
   * dedicated operation that validates all prerequisites atomically."
   * Nothing in Phase 2A ever populates `frontendJobId`/`artifactId`/
   * `backendRuntimeId`, so this always refuses today; it exists now so the
   * invariant it enforces is fixed and testable before any worker can ever
   * call it.
   */
  async activateReady(previewId: string): Promise<FullStackPreview> {
    const updated = await this.store.update(previewId, (preview) => {
      if (preview.status !== "starting_backend") {
        throw invalidTransition(preview.status, "ready")
      }
      if (
        !preview.frontendJobId ||
        !preview.artifactId ||
        !preview.backendRuntimeId
      ) {
        throw new FullStackPreviewControlError(
          "INVALID_TRANSITION",
          "A full-stack preview cannot become ready before its frontend artifact and backend runtime are both recorded.",
          409,
        )
      }
      return transition(preview, "ready", this.now())
    })
    return toPublicPreview(updated)
  }

  /** Worker-only admission, mirroring `PreviewControlPlane.startWorkerJob`/
   * `BackendRuntimeControlPlane.startWorkerRuntime` exactly. No worker
   * calls this yet in Phase 2A. */
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
      // "ready"/"stopping": unreachable in Phase 2A. Once reachable, aging
      // out here should become "expired", mirroring the static
      // artifact/preview-job pattern -- not "failed", since the preview
      // did successfully activate before its (future, tighter) expiry
      // simply elapsed.
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
