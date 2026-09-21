import { PREVIEW_CONTRACT_VERSION } from "../../types/analysis"
import { BACKEND_RUNTIME_CONTRACT_VERSION } from "../../types/backendRuntime"
import type { QueuedFullStackPreview } from "../../types/fullstackPreview"
import type { PreviewJobStatus } from "../../types/preview"
import type { BackendRuntimeStatus } from "../../types/backendRuntime"
import type { BackendRuntimeControlPlane } from "../backend-runtime-api/controlPlane"
import type { FullStackPreviewControlPlane } from "../fullstack-preview-api/controlPlane"
import type { StoredFullStackPreview } from "../fullstack-preview-api/ports"
import type { PreviewControlPlane } from "../preview-api/controlPlane"
import type { PreviewArtifactCache } from "../preview-api/ports"

export interface FullStackPreviewRunOptions {
  signal?: AbortSignal
  recovered?: boolean
  abandon?: boolean
}

export interface FullStackPreviewSupervisorOptions {
  pollIntervalMs?: number
  now?: () => Date
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

const ACTIVE_FRONTEND = new Set<PreviewJobStatus>([
  "queued",
  "fetching",
  "installing",
  "building",
  "publishing",
])
const ACTIVE_BACKEND = new Set<BackendRuntimeStatus>([
  "queued",
  "fetching",
  "installing",
  "starting",
  "running",
  "stopping",
])

/**
 * Coordinates, but never executes, the static and backend child pipelines.
 * While Phase 3 routing is absent this supervisor intentionally retains its
 * queue lease in `awaiting_activation`, monitoring cancellation, expiry, and
 * backend liveness. Tests finish that temporary ownership period by cancelling
 * the parent; production does not start this worker yet.
 */
export class FullStackPreviewSupervisor {
  private readonly pollIntervalMs: number
  private readonly now: () => Date
  private readonly wait: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>

  constructor(
    private readonly fullStack: FullStackPreviewControlPlane,
    private readonly frontend: PreviewControlPlane,
    private readonly artifacts: PreviewArtifactCache,
    private readonly backend: BackendRuntimeControlPlane,
    options: FullStackPreviewSupervisorOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 500
    if (
      !Number.isSafeInteger(this.pollIntervalMs) ||
      this.pollIntervalMs < 1 ||
      this.pollIntervalMs > 60_000
    ) {
      throw new Error(
        "Full-stack preview poll interval must be between 1 and 60000 milliseconds.",
      )
    }
    this.now = options.now ?? (() => new Date())
    this.wait = options.wait ?? waitForAbortableDelay
  }

  async run(
    queued: QueuedFullStackPreview,
    options: FullStackPreviewRunOptions = {},
  ): Promise<void> {
    const signal = options.signal ?? new AbortController().signal
    signal.throwIfAborted()

    const authoritative = await this.fullStack.getWorkerFullStackPreview(
      queued.previewId,
    )
    if (!authoritative) return

    if (!sameQueuedPreview(queued, authoritative)) {
      await this.cleanup(authoritative)
      await this.fullStack.failWorkerFullStackPreview(
        queued.previewId,
        "ORCHESTRATION_UNAVAILABLE",
      )
      return
    }

    if (
      options.abandon ||
      (options.recovered && authoritative.status !== "queued")
    ) {
      await this.cleanup(authoritative)
      await this.fullStack.failWorkerFullStackPreview(
        queued.previewId,
        "ORCHESTRATION_UNAVAILABLE",
      )
      return
    }

    if (
      !(await this.fullStack.startWorkerFullStackPreview(
        queued.previewId,
        options.recovered,
        options.abandon,
      ))
    ) {
      return
    }

    let frontendJobId: string | undefined
    let backendRuntimeId: string | undefined
    try {
      let frontendResult
      try {
        frontendResult = await this.frontend.createForOrchestration(
          {
            repository: structuredClone(authoritative.repository),
            contractVersion: PREVIEW_CONTRACT_VERSION,
            target: { sourceRoot: authoritative.frontendSourceRoot },
          },
          frontendIdempotencyKey(authoritative.id),
          authoritative.requesterId,
        )
      } catch {
        await this.fullStack.failWorkerFullStackPreview(
          authoritative.id,
          "FRONTEND_FAILED",
        )
        return
      }

      frontendJobId = frontendResult.job.id
      await this.fullStack.recordFrontendJob(authoritative.id, frontendJobId)

      const frontendJob = await this.waitForFrontend(
        authoritative.id,
        frontendJobId,
        authoritative.requesterId,
        signal,
      )
      if (!frontendJob) return

      const cached = await this.artifacts.get(frontendJob.cacheKey, this.now())
      if (!cached) {
        await this.fullStack.failWorkerFullStackPreview(
          authoritative.id,
          "FRONTEND_FAILED",
        )
        return
      }
      await this.fullStack.recordFrontendArtifact(authoritative.id, {
        frontendJobId,
        artifactId: cached.artifactId,
        artifactExpiresAt: cached.expiresAt,
      })

      if (!(await this.parentIsActive(authoritative.id))) return

      let backendResult
      try {
        backendResult = await this.backend.createForOrchestration(
          {
            repository: structuredClone(authoritative.repository),
            contractVersion: BACKEND_RUNTIME_CONTRACT_VERSION,
            sourceRoot: authoritative.backendSourceRoot,
          },
          authoritative.requesterId,
          authoritative.id,
        )
      } catch {
        await this.fullStack.failWorkerFullStackPreview(
          authoritative.id,
          "BACKEND_FAILED",
        )
        return
      }

      backendRuntimeId = backendResult.runtime.id
      await this.fullStack.recordBackendRuntime(
        authoritative.id,
        backendRuntimeId,
      )

      const runtime = await this.waitForBackend(
        authoritative.id,
        backendRuntimeId,
        authoritative.requesterId,
        signal,
      )
      if (!runtime) return

      await this.fullStack.markBackendRunning(authoritative.id, {
        backendRuntimeId,
        backendExpiresAt: new Date(runtime.expiresAt),
      })

      await this.monitorAwaitingActivation(
        authoritative.id,
        backendRuntimeId,
        authoritative.requesterId,
        signal,
      )
    } catch (error) {
      await this.cleanup(
        await this.fullStack.getWorkerFullStackPreview(authoritative.id),
        frontendJobId,
        backendRuntimeId,
      )
      await this.fullStack.failWorkerFullStackPreview(
        authoritative.id,
        "ORCHESTRATION_UNAVAILABLE",
      )
      throw error
    }
  }

  private async waitForFrontend(
    previewId: string,
    jobId: string,
    requesterSubject: string,
    signal: AbortSignal,
  ) {
    for (;;) {
      signal.throwIfAborted()
      if (!(await this.parentIsActive(previewId))) {
        await this.cancelFrontend(jobId, requesterSubject)
        return null
      }
      const job = await this.frontend.getForOrchestration(
        jobId,
        requesterSubject,
      )
      if (job.status === "ready") return job
      if (!ACTIVE_FRONTEND.has(job.status)) {
        await this.fullStack.failWorkerFullStackPreview(
          previewId,
          "FRONTEND_FAILED",
        )
        return null
      }
      await this.wait(this.pollIntervalMs, signal)
    }
  }

  private async waitForBackend(
    previewId: string,
    runtimeId: string,
    requesterSubject: string,
    signal: AbortSignal,
  ) {
    for (;;) {
      signal.throwIfAborted()
      if (!(await this.parentIsActive(previewId))) {
        await this.cancelBackend(runtimeId, requesterSubject)
        return null
      }
      const runtime = await this.backend.getForOrchestration(
        runtimeId,
        requesterSubject,
      )
      if (runtime.status === "running") return runtime
      if (!ACTIVE_BACKEND.has(runtime.status)) {
        await this.fullStack.failWorkerFullStackPreview(
          previewId,
          "BACKEND_FAILED",
        )
        return null
      }
      await this.wait(this.pollIntervalMs, signal)
    }
  }

  private async monitorAwaitingActivation(
    previewId: string,
    runtimeId: string,
    requesterSubject: string,
    signal: AbortSignal,
  ): Promise<void> {
    for (;;) {
      signal.throwIfAborted()
      const parent = await this.fullStack.getWorkerFullStackPreview(previewId)
      if (!parent || parent.status !== "awaiting_activation") {
        if (parent?.status !== "ready") {
          await this.cancelBackend(runtimeId, requesterSubject)
        }
        return
      }
      const runtime = await this.backend.getForOrchestration(
        runtimeId,
        requesterSubject,
      )
      if (runtime.status !== "running") {
        await this.fullStack.failWorkerFullStackPreview(
          previewId,
          "BACKEND_FAILED",
        )
        await this.cancelBackend(runtimeId, requesterSubject)
        return
      }
      await this.wait(this.pollIntervalMs, signal)
    }
  }

  private async parentIsActive(previewId: string): Promise<boolean> {
    const preview = await this.fullStack.getWorkerFullStackPreview(previewId)
    return Boolean(
      preview &&
      (preview.status === "building_frontend" ||
        preview.status === "starting_backend" ||
        preview.status === "awaiting_activation"),
    )
  }

  private async cleanup(
    preview: StoredFullStackPreview | null,
    frontendJobId?: string,
    backendRuntimeId?: string,
  ): Promise<void> {
    const requesterSubject = preview?.requesterId
    if (!requesterSubject) return
    await this.cancelBackend(
      backendRuntimeId ?? preview.backendRuntimeId,
      requesterSubject,
    )
    await this.cancelFrontend(
      frontendJobId ?? preview.frontendJobId,
      requesterSubject,
    )
  }

  private async cancelFrontend(
    jobId: string | null | undefined,
    requesterSubject: string,
  ): Promise<void> {
    if (!jobId) return
    try {
      const job = await this.frontend.getForOrchestration(
        jobId,
        requesterSubject,
      )
      if (ACTIVE_FRONTEND.has(job.status)) {
        await this.frontend.cancelForOrchestration(jobId, requesterSubject)
      }
    } catch {
      // Cleanup is best-effort; persisted child ids remain for reconciliation.
    }
  }

  private async cancelBackend(
    runtimeId: string | null | undefined,
    requesterSubject: string,
  ): Promise<void> {
    if (!runtimeId) return
    try {
      const runtime = await this.backend.getForOrchestration(
        runtimeId,
        requesterSubject,
      )
      if (ACTIVE_BACKEND.has(runtime.status)) {
        await this.backend.cancelForOrchestration(runtimeId, requesterSubject)
      }
    } catch {
      // Cleanup is best-effort; persisted child ids remain for reconciliation.
    }
  }
}

export function frontendIdempotencyKey(previewId: string): string {
  const key = `fullstack:${previewId}:frontend`
  if (!/^[\x21-\x7e]{16,128}$/.test(key)) {
    throw new Error("Full-stack frontend idempotency key is invalid.")
  }
  return key
}

function sameQueuedPreview(
  queued: QueuedFullStackPreview,
  stored: StoredFullStackPreview,
): boolean {
  return (
    queued.previewId === stored.id &&
    queued.repository.repositoryId === stored.repository.repositoryId &&
    queued.repository.owner.toLowerCase() ===
      stored.repository.owner.toLowerCase() &&
    queued.repository.name.toLowerCase() ===
      stored.repository.name.toLowerCase() &&
    queued.repository.commitSha.toLowerCase() ===
      stored.repository.commitSha.toLowerCase() &&
    queued.frontendSourceRoot === stored.frontendSourceRoot &&
    queued.backendSourceRoot === stored.backendSourceRoot
  )
}

function waitForAbortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timeout = setTimeout(finish, milliseconds)
    function finish() {
      clearTimeout(timeout)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    signal.addEventListener("abort", finish, { once: true })
  })
}
