import { BACKEND_RUNTIME_CONTRACT_VERSION } from "../../types/backendRuntime"
import type {
  BackendRuntime,
  BackendRuntimeErrorCode,
  BackendRuntimeStatus,
  CreateBackendRuntimeRequest,
} from "../../types/backendRuntime"
import type { PreviewRequester } from "../../types/preview"
import { validateRepositoryRef } from "../../core/preview/buildPlan"
import { isSafePreviewSourceRoot } from "../../core/preview/sourceRoot"
import { validateBackendRuntimePlan } from "../../core/preview/backendRuntimePlanValidator"
import { BackendRuntimeControlError } from "./errors"
import type {
  BackendRuntimePlanResolver,
  BackendRuntimeQueue,
  BackendRuntimeStore,
  StoredBackendRuntime,
} from "./ports"

const ACTIVE_STATUSES = new Set<BackendRuntimeStatus>([
  "queued",
  "fetching",
  "installing",
  "starting",
  "running",
  "stopping",
])

const TERMINAL_STATUSES = new Set<BackendRuntimeStatus>([
  "stopped",
  "failed",
  "cancelled",
  "expired",
])

const NEXT_PHASES = new Map<BackendRuntimeStatus, Set<BackendRuntimeStatus>>([
  ["queued", new Set(["fetching"])],
  ["fetching", new Set(["installing"])],
  ["installing", new Set(["starting"])],
  ["starting", new Set(["running"])],
])

const SAFE_ERROR_MESSAGES: Record<BackendRuntimeErrorCode, string> = {
  FETCH_FAILED: "The repository source could not be fetched.",
  UNSUPPORTED_BACKEND: "This backend does not satisfy the backend-v1 contract.",
  INSTALL_FAILED: "Backend dependencies could not be installed.",
  RUNTIME_START_FAILED: "The backend process could not be started.",
  RUNTIME_READINESS_TIMEOUT: "The backend did not become ready in time.",
  RUNTIME_EXITED: "The backend process exited unexpectedly.",
  RUNTIME_TIMEOUT: "The backend runtime exceeded its time limit.",
  RUNTIME_DISK_LIMIT: "The backend runtime exceeded its sandbox disk limit.",
  RUNTIME_UNAVAILABLE: "No backend runtime worker was available.",
}

export interface BackendRuntimeControlPlaneOptions {
  /** Default 10 minutes -- see docs/PREVIEW_RUNTIME.md "Runtime lifetime". */
  runtimeTtlMs?: number
  /** Default 1 -- see docs/PREVIEW_RUNTIME.md "Queue / idempotency". */
  maxActiveRuntimesPerRequester?: number
  now?: () => Date
  createId?: () => string
}

export interface CreateBackendRuntimeResult {
  created: boolean
  runtime: BackendRuntime
}

/**
 * Fully separate from `PreviewControlPlane`: a backend runtime is not
 * cacheable output, and its lifecycle (queued/fetching/installing/starting/
 * running/stopping/stopped, or failed/cancelled/expired) has no analogue in
 * the static build/publish state machine. See docs/PREVIEW_RUNTIME.md.
 */
export class BackendRuntimeControlPlane {
  private readonly runtimeTtlMs: number
  private readonly maxActiveRuntimesPerRequester: number
  private readonly now: () => Date
  private readonly createId: () => string

  constructor(
    private readonly planResolver: BackendRuntimePlanResolver,
    private readonly store: BackendRuntimeStore,
    private readonly queue: BackendRuntimeQueue,
    options: BackendRuntimeControlPlaneOptions = {},
  ) {
    this.runtimeTtlMs = options.runtimeTtlMs ?? 10 * 60_000
    this.maxActiveRuntimesPerRequester =
      options.maxActiveRuntimesPerRequester ?? 1
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? (() => crypto.randomUUID())
  }

  async create(
    request: CreateBackendRuntimeRequest,
    requester: PreviewRequester,
  ): Promise<CreateBackendRuntimeResult> {
    validateRequester(requester)
    return this.createInternal(request, requester.subject, null)
  }

  /** Trusted worker-only path. The full-stack id is the durable isolation
   * identity: retries reuse this preview's active runtime, while another
   * full-stack preview can never share it. */
  async createForOrchestration(
    request: CreateBackendRuntimeRequest,
    requesterSubject: string,
    orchestrationKey: string,
  ): Promise<CreateBackendRuntimeResult> {
    validateRequesterSubject(requesterSubject)
    if (!/^fullstack-[a-z\d-]{8,64}$/i.test(orchestrationKey)) {
      throw new BackendRuntimeControlError(
        "INVALID_REQUEST",
        "The backend orchestration identity is invalid.",
        400,
      )
    }
    return this.createInternal(request, requesterSubject, orchestrationKey)
  }

  private async createInternal(
    request: CreateBackendRuntimeRequest,
    requesterSubject: string,
    orchestrationKey: string | null,
  ): Promise<CreateBackendRuntimeResult> {
    validateCreateInput(request)

    const fingerprint = await createFingerprint(request)
    const existing = orchestrationKey
      ? await this.store.getActiveByOrchestrationKey(
          requesterSubject,
          orchestrationKey,
        )
      : await this.store.getActiveByFingerprint(requesterSubject, fingerprint)
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new BackendRuntimeControlError(
          "CONFLICT",
          "The backend orchestration identity was already used for a different request.",
          409,
        )
      }
      return { created: false, runtime: toPublicRuntime(existing) }
    }

    const activeCount =
      await this.store.countActiveByRequester(requesterSubject)
    if (activeCount >= this.maxActiveRuntimesPerRequester) {
      throw new BackendRuntimeControlError(
        "RATE_LIMITED",
        "Only one active backend runtime is allowed per requester at a time.",
        429,
        30,
      )
    }

    const resolvedPlan = await this.planResolver.resolve(
      structuredClone(request.repository),
      request.sourceRoot,
    )
    if (!resolvedPlan) {
      throw new BackendRuntimeControlError(
        "UNSUPPORTED_BACKEND",
        "This backend does not satisfy the backend-v1 contract.",
        422,
      )
    }
    // Preserve standalone backend-v1 behavior. The trusted orchestration
    // boundary adds its own independent validation before accepting a plan.
    const plan = orchestrationKey
      ? validateResolvedPlan(resolvedPlan, request)
      : resolvedPlan

    const now = this.now()
    const id = this.createId()
    const expiresAt = new Date(now.getTime() + this.runtimeTtlMs)
    const runtime: StoredBackendRuntime = {
      id,
      requesterId: requesterSubject,
      fingerprint,
      orchestrationKey,
      repository: structuredClone(request.repository),
      sourceRoot: plan.sourceRoot,
      adapterId: plan.adapterId,
      plan,
      status: "queued",
      errorCode: null,
      errorMessage: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    }

    const created = await this.store.create(runtime)

    try {
      await this.queue.enqueue({
        runtimeId: created.id,
        repository: created.repository,
        plan: created.plan,
      })
    } catch {
      const failed = await this.fail(created.id, "RUNTIME_UNAVAILABLE")
      return { created: true, runtime: failed }
    }

    return { created: true, runtime: toPublicRuntime(created) }
  }

  async getForOrchestration(
    runtimeId: string,
    requesterSubject: string,
  ): Promise<BackendRuntime> {
    validateRequesterSubject(requesterSubject)
    const runtime = await this.getOwnedRuntime(runtimeId, requesterSubject)
    return toPublicRuntime(await this.refreshExpiry(runtime))
  }

  async cancelForOrchestration(
    runtimeId: string,
    requesterSubject: string,
  ): Promise<BackendRuntime> {
    validateRequesterSubject(requesterSubject)
    return this.cancelOwned(runtimeId, requesterSubject)
  }

  async get(
    runtimeId: string,
    requester: PreviewRequester,
  ): Promise<BackendRuntime> {
    validateRequester(requester)
    const runtime = await this.getOwnedRuntime(runtimeId, requester.subject)
    return toPublicRuntime(await this.refreshExpiry(runtime))
  }

  async cancel(
    runtimeId: string,
    requester: PreviewRequester,
  ): Promise<BackendRuntime> {
    validateRequester(requester)
    return this.cancelOwned(runtimeId, requester.subject)
  }

  private async cancelOwned(
    runtimeId: string,
    requesterSubject: string,
  ): Promise<BackendRuntime> {
    const current = await this.getOwnedRuntime(runtimeId, requesterSubject)
    const refreshed = await this.refreshExpiry(current)

    if (TERMINAL_STATUSES.has(refreshed.status)) {
      return toPublicRuntime(refreshed)
    }

    const updated = await this.store.update(runtimeId, (runtime) => {
      if (TERMINAL_STATUSES.has(runtime.status)) return runtime
      const target: BackendRuntimeStatus =
        runtime.status === "running" || runtime.status === "stopping"
          ? "stopping"
          : "cancelled"
      return transition(runtime, target, this.now())
    })
    await this.queue.cancel(runtimeId).catch(() => undefined)
    return toPublicRuntime(updated)
  }

  async markPhase(
    runtimeId: string,
    status: "fetching" | "installing" | "starting" | "running",
  ): Promise<BackendRuntime> {
    const updated = await this.store.update(runtimeId, (runtime) => {
      const allowed = NEXT_PHASES.get(runtime.status)
      if (!allowed?.has(status)) throw invalidTransition(runtime.status, status)
      return transition(runtime, status, this.now())
    })
    return toPublicRuntime(updated)
  }

  /** Worker-only admission, mirroring `PreviewControlPlane.startWorkerJob`. */
  async startWorkerRuntime(
    runtimeId: string,
    recovered = false,
    abandon = false,
  ): Promise<boolean> {
    let started = false
    await this.store.update(runtimeId, (runtime) => {
      if (!ACTIVE_STATUSES.has(runtime.status)) return runtime
      if (abandon || (recovered && runtime.status !== "queued")) {
        return {
          ...transition(runtime, "failed", this.now()),
          errorCode: "RUNTIME_UNAVAILABLE",
          errorMessage: SAFE_ERROR_MESSAGES.RUNTIME_UNAVAILABLE,
        }
      }
      if (runtime.status !== "queued") return runtime
      started = true
      return transition(runtime, "fetching", this.now())
    })
    return started
  }

  /** True while the worker should keep the process running; false once a
   * stop was requested (cancel/expiry) or the runtime reached a terminal
   * status through any other path -- the worker's monitoring loop polls
   * this instead of only checking "still exists". */
  async shouldContinueRunning(runtimeId: string): Promise<boolean> {
    const runtime = await this.store.get(runtimeId)
    if (!runtime) return false
    const refreshed = await this.refreshExpiry(runtime)
    return refreshed.status === "running"
  }

  async isWorkerRuntimeActive(runtimeId: string): Promise<boolean> {
    const runtime = await this.store.get(runtimeId)
    return (
      runtime !== null &&
      ACTIVE_STATUSES.has((await this.refreshExpiry(runtime)).status)
    )
  }

  async markStopped(runtimeId: string): Promise<void> {
    await this.store.update(runtimeId, (runtime) =>
      runtime.status === "stopping"
        ? transition(runtime, "stopped", this.now())
        : runtime,
    )
  }

  async failWorkerRuntime(
    runtimeId: string,
    code: BackendRuntimeErrorCode,
  ): Promise<void> {
    await this.store.update(runtimeId, (runtime) =>
      ACTIVE_STATUSES.has(runtime.status)
        ? {
            ...transition(runtime, "failed", this.now()),
            errorCode: code,
            errorMessage: SAFE_ERROR_MESSAGES[code],
          }
        : runtime,
    )
  }

  async fail(
    runtimeId: string,
    errorCode: BackendRuntimeErrorCode,
  ): Promise<BackendRuntime> {
    const updated = await this.store.update(runtimeId, (runtime) => ({
      ...transition(runtime, "failed", this.now()),
      errorCode,
      errorMessage: SAFE_ERROR_MESSAGES[errorCode],
    }))
    return toPublicRuntime(updated)
  }

  private async getOwnedRuntime(
    runtimeId: string,
    requesterId: string,
  ): Promise<StoredBackendRuntime> {
    if (!/^[a-z\d-]{8,64}$/i.test(runtimeId)) {
      throw new BackendRuntimeControlError(
        "NOT_FOUND",
        "Backend runtime not found.",
        404,
      )
    }
    const runtime = await this.store.get(runtimeId)
    if (!runtime || runtime.requesterId !== requesterId) {
      throw new BackendRuntimeControlError(
        "NOT_FOUND",
        "Backend runtime not found.",
        404,
      )
    }
    return runtime
  }

  private async refreshExpiry(
    runtime: StoredBackendRuntime,
  ): Promise<StoredBackendRuntime> {
    if (new Date(runtime.expiresAt).getTime() > this.now().getTime()) {
      return runtime
    }
    if (TERMINAL_STATUSES.has(runtime.status)) {
      return runtime
    }
    return this.store.update(runtime.id, (current) =>
      TERMINAL_STATUSES.has(current.status)
        ? current
        : transition(current, "expired", this.now()),
    )
  }
}

function validateCreateInput(request: CreateBackendRuntimeRequest): void {
  try {
    validateRepositoryRef(request.repository)
  } catch (error) {
    throw new BackendRuntimeControlError(
      "INVALID_REQUEST",
      error instanceof Error
        ? error.message
        : "Backend runtime request is invalid.",
      400,
    )
  }

  if (request.contractVersion !== BACKEND_RUNTIME_CONTRACT_VERSION) {
    throw new BackendRuntimeControlError(
      "INVALID_REQUEST",
      "Unsupported backend runtime contract version.",
      400,
    )
  }

  if (
    request.sourceRoot !== undefined &&
    !isSafePreviewSourceRoot(request.sourceRoot)
  ) {
    throw new BackendRuntimeControlError(
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
    throw new BackendRuntimeControlError(
      "INVALID_REQUEST",
      "A valid backend runtime requester is required.",
      400,
    )
  }
}

function validateRequesterSubject(requesterSubject: string): void {
  if (!requesterSubject || requesterSubject.length > 128) {
    throw new BackendRuntimeControlError(
      "INVALID_REQUEST",
      "A valid backend runtime requester is required.",
      400,
    )
  }
}

function validateResolvedPlan(
  value: Parameters<typeof validateBackendRuntimePlan>[0],
  request: CreateBackendRuntimeRequest,
): ReturnType<typeof validateBackendRuntimePlan> {
  const plan = validateBackendRuntimePlan(value)
  if (
    !sameRepository(plan.repository, request.repository) ||
    (request.sourceRoot !== undefined && plan.sourceRoot !== request.sourceRoot)
  ) {
    throw new BackendRuntimeControlError(
      "CONFLICT",
      "Resolved backend identity does not match the requested commit or source root.",
      409,
    )
  }
  return plan
}

function sameRepository(
  left: CreateBackendRuntimeRequest["repository"],
  right: CreateBackendRuntimeRequest["repository"],
): boolean {
  return (
    left.repositoryId === right.repositoryId &&
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase() &&
    left.commitSha.toLowerCase() === right.commitSha.toLowerCase()
  )
}

async function createFingerprint(
  request: CreateBackendRuntimeRequest,
): Promise<string> {
  const canonical = JSON.stringify({
    repositoryId: request.repository.repositoryId,
    owner: request.repository.owner.toLowerCase(),
    name: request.repository.name.toLowerCase(),
    commitSha: request.repository.commitSha.toLowerCase(),
    contractVersion: request.contractVersion,
    sourceRoot: request.sourceRoot ?? null,
  })
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")
}

function transition(
  runtime: StoredBackendRuntime,
  status: BackendRuntimeStatus,
  now: Date,
): StoredBackendRuntime {
  return { ...runtime, status, updatedAt: now.toISOString() }
}

function invalidTransition(
  from: BackendRuntimeStatus,
  to: BackendRuntimeStatus,
): BackendRuntimeControlError {
  return new BackendRuntimeControlError(
    "INVALID_TRANSITION",
    `Backend runtime cannot transition from ${from} to ${to}.`,
    409,
  )
}

function toPublicRuntime(runtime: StoredBackendRuntime): BackendRuntime {
  return structuredClone({
    id: runtime.id,
    repository: runtime.repository,
    sourceRoot: runtime.sourceRoot,
    adapterId: runtime.adapterId,
    status: runtime.status,
    errorCode: runtime.errorCode,
    errorMessage: runtime.errorMessage,
    createdAt: runtime.createdAt,
    updatedAt: runtime.updatedAt,
    expiresAt: runtime.expiresAt,
  } satisfies BackendRuntime)
}
