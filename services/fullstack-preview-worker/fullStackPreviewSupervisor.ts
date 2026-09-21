import { PREVIEW_CONTRACT_VERSION } from "../../types/analysis"
import { BACKEND_RUNTIME_CONTRACT_VERSION } from "../../types/backendRuntime"
import type { QueuedFullStackPreview } from "../../types/fullstackPreview"
import type { PreviewJobStatus } from "../../types/preview"
import type { BackendRuntimeStatus } from "../../types/backendRuntime"
import type { BackendRuntimeControlPlane } from "../backend-runtime-api/controlPlane"
import { BackendRuntimeControlError } from "../backend-runtime-api/errors"
import type { FullStackPreviewControlPlane } from "../fullstack-preview-api/controlPlane"
import type { StoredFullStackPreview } from "../fullstack-preview-api/ports"
import type { PreviewControlPlane } from "../preview-api/controlPlane"
import { PreviewControlError } from "../preview-api/errors"
import type { PreviewArtifactCache } from "../preview-api/ports"
import type { FullStackRoutingActivator } from "../fullstack-routing/fullStackRoutingActivator"
import type { LiveBackendRuntimeRouteResolver } from "../backend-runtime-worker/liveRuntimeRegistry"

export interface FullStackPreviewRunOptions {
  signal?: AbortSignal
  /** The process shutdown source, kept separate from lease-loss aborts. */
  shutdownSignal?: AbortSignal
  recovered?: boolean
  abandon?: boolean
}

export interface FullStackPreviewSupervisorOptions {
  pollIntervalMs?: number
  now?: () => Date
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  routingActivator?: Pick<FullStackRoutingActivator, "activate">
  liveRuntimeResolver?: LiveBackendRuntimeRouteResolver
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
 * The durable parent queue lease is the lifecycle ownership token. This
 * supervisor does not return at `ready`: it owns cancellation, expiry and
 * backend-failure cleanup through a final terminal state.
 */
export class FullStackPreviewSupervisor {
  private readonly pollIntervalMs: number
  private readonly now: () => Date
  private readonly wait: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>
  private readonly routingActivator:
    Pick<FullStackRoutingActivator, "activate"> | undefined
  private readonly liveRuntimeResolver:
    LiveBackendRuntimeRouteResolver | undefined

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
    this.routingActivator = options.routingActivator
    this.liveRuntimeResolver = options.liveRuntimeResolver
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
      await this.fullStack.failWorkerFullStackPreview(
        queued.previewId,
        "ORCHESTRATION_UNAVAILABLE",
      )
      await this.cleanup(authoritative, undefined, undefined, signal)
      return
    }

    if (
      options.abandon ||
      (options.recovered && authoritative.status !== "queued")
    ) {
      await this.fullStack.failWorkerFullStackPreview(
        queued.previewId,
        "ORCHESTRATION_UNAVAILABLE",
      )
      await this.cleanup(authoritative, undefined, undefined, signal)
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
      } catch (error) {
        await this.fullStack.failWorkerFullStackPreview(
          authoritative.id,
          isUpstreamUnavailable(error)
            ? "ORCHESTRATION_UNAVAILABLE"
            : "FRONTEND_FAILED",
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
      } catch (error) {
        await this.fullStack.failWorkerFullStackPreview(
          authoritative.id,
          isUpstreamUnavailable(error)
            ? "ORCHESTRATION_UNAVAILABLE"
            : "BACKEND_FAILED",
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

      await this.monitorLifecycle(
        authoritative.id,
        backendRuntimeId,
        authoritative.requesterId,
        signal,
      )
    } catch (error) {
      // A normal process shutdown deliberately leaves the durable parent for
      // next-start fail-closed reconciliation. The backend worker is aborted
      // and awaited separately by production shutdown; do not rewrite a
      // valid ready parent merely because this process is exiting.
      if (signal.aborted && options.shutdownSignal?.aborted) throw error
      await this.fullStack.failWorkerFullStackPreview(
        authoritative.id,
        "ORCHESTRATION_UNAVAILABLE",
      )
      await this.cleanup(
        await this.fullStack.getWorkerFullStackPreview(authoritative.id),
        frontendJobId,
        backendRuntimeId,
        signal.aborted ? undefined : signal,
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
        await this.stopBackendAndWait(runtimeId, requesterSubject, signal)
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
        await this.stopBackendAndWait(runtimeId, requesterSubject, signal)
        return null
      }
      await this.wait(this.pollIntervalMs, signal)
    }
  }

  private async monitorLifecycle(
    previewId: string,
    runtimeId: string,
    requesterSubject: string,
    signal: AbortSignal,
  ): Promise<void> {
    for (;;) {
      signal.throwIfAborted()
      const parent = await this.fullStack.getWorkerFullStackPreview(previewId)
      if (!parent) {
        await this.stopBackendAndWait(runtimeId, requesterSubject, signal)
        return
      }

      if (parent.status === "awaiting_activation") {
        // Kept only for unit/backward-compatible portable composition. The
        // production composition always injects both routing dependencies.
        if (!this.routingActivator || !this.liveRuntimeResolver) {
          const runtime = await this.backend.getForOrchestration(
            runtimeId,
            requesterSubject,
          )
          if (runtime.status !== "running") {
            await this.fullStack.failWorkerFullStackPreview(
              previewId,
              "BACKEND_FAILED",
            )
            await this.stopBackendAndWait(runtimeId, requesterSubject, signal)
            return
          }
          await this.wait(this.pollIntervalMs, signal)
          continue
        }
        try {
          await this.routingActivator.activate(previewId)
        } catch {
          signal.throwIfAborted()
          await this.fullStack.failWorkerFullStackPreview(
            previewId,
            "ORCHESTRATION_UNAVAILABLE",
          )
          await this.stopBackendAndWait(runtimeId, requesterSubject, signal)
          return
        }
        continue
      }

      if (parent.status === "ready") {
        let running: boolean
        try {
          const runtime = await this.backend.getForOrchestration(
            runtimeId,
            requesterSubject,
          )
          running =
            runtime.status === "running" &&
            this.liveRuntimeResolver?.resolve(runtimeId) !== undefined
        } catch {
          running = false
        }
        if (running) {
          await this.wait(this.pollIntervalMs, signal)
          continue
        }
        await this.fullStack.failWorkerFullStackPreview(
          previewId,
          "BACKEND_FAILED",
        )
        await this.stopBackendAndWait(runtimeId, requesterSubject, signal)
        return
      }

      if (parent.status === "stopping") {
        await this.stopBackendAndWait(runtimeId, requesterSubject, signal)
        const current =
          await this.fullStack.getWorkerFullStackPreview(previewId)
        if (current?.status === "stopping") {
          await this.fullStack.markPhase(previewId, "stopped")
        }
        return
      }

      // cancelled/expired/failed/stopped are terminal. Cleanup must finish
      // before the caller returns and the durable delivery is ACKed.
      await this.stopBackendAndWait(runtimeId, requesterSubject, signal)
      if (parent.status !== "stopped") {
        await this.cancelFrontend(parent.frontendJobId, requesterSubject)
      }
      return
    }
  }

  private async stopBackendAndWait(
    runtimeId: string | null | undefined,
    requesterSubject: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!runtimeId) return
    await this.cancelBackend(runtimeId, requesterSubject)
    if (!this.liveRuntimeResolver) return
    for (;;) {
      signal.throwIfAborted()
      let active: boolean
      try {
        const runtime = await this.backend.getForOrchestration(
          runtimeId,
          requesterSubject,
        )
        active = ACTIVE_BACKEND.has(runtime.status)
      } catch {
        active = false
      }
      let routeExists: boolean
      try {
        routeExists = this.liveRuntimeResolver?.resolve(runtimeId) !== undefined
      } catch {
        routeExists = false
      }
      if (!active && !routeExists) return
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
    signal?: AbortSignal,
  ): Promise<void> {
    const requesterSubject = preview?.requesterId
    if (!requesterSubject) return
    const runtimeId = backendRuntimeId ?? preview.backendRuntimeId
    if (signal && this.liveRuntimeResolver) {
      await this.stopBackendAndWait(runtimeId, requesterSubject, signal)
    } else {
      await this.cancelBackend(runtimeId, requesterSubject)
    }
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

/** True when a child's `createForOrchestration` failed only because its own
 * control plane could not authorize/create it right now (e.g. the shared
 * GitHub upstream mapping produced `UPSTREAM_UNAVAILABLE`) rather than a
 * real, durable frontend/backend failure. Distinguishing this prevents a
 * temporary upstream outage from being mislabeled as an actual build or
 * runtime failure. */
function isUpstreamUnavailable(error: unknown): boolean {
  return (
    (error instanceof PreviewControlError ||
      error instanceof BackendRuntimeControlError) &&
    error.code === "UPSTREAM_UNAVAILABLE"
  )
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
