import type { PreviewJobErrorCode, QueuedPreviewJob } from "../../types/preview"
import { RunnerDiskLimitError } from "./local/commandRunner"
import {
  DEFAULT_ARCHIVE_LIMITS,
  DEFAULT_OUTPUT_LIMITS,
  validateFetchedArchive,
  validateResolvedOutput,
  type ArchiveLimits,
  type OutputLimits,
} from "../../core/runner/archivePolicy"
import type { PreviewControlPlane } from "../preview-api/controlPlane"
import { DEFAULT_RUNNER_TIMEOUTS } from "../../core/runner/runnerLimits"
import type {
  ArtifactPublisher,
  BuildExecutor,
  DependencyInstaller,
  OutputResolver,
  PreviewWorkspace,
  SandboxProvisioner,
  SourceArchiveFetcher,
} from "./ports"

export interface PreviewJobWorkerOptions {
  archiveLimits?: ArchiveLimits
  outputLimits?: OutputLimits
  cancellationPollMs?: number
  totalJobTimeoutMs?: number
  cleanup?: (job: QueuedPreviewJob) => void | Promise<void>
}

export interface PreviewJobRunOptions {
  signal?: AbortSignal
  recovered?: boolean
  abandon?: boolean
}

export class PreviewJobWorker {
  private readonly archiveLimits: ArchiveLimits
  private readonly outputLimits: OutputLimits

  constructor(
    private readonly controlPlane: PreviewControlPlane,
    private readonly archiveFetcher: SourceArchiveFetcher,
    private readonly sandbox: SandboxProvisioner,
    private readonly installer: DependencyInstaller,
    private readonly builder: BuildExecutor,
    private readonly outputResolver: OutputResolver,
    private readonly publisher: ArtifactPublisher,
    private readonly options: PreviewJobWorkerOptions = {},
  ) {
    this.archiveLimits = options.archiveLimits ?? DEFAULT_ARCHIVE_LIMITS
    this.outputLimits = options.outputLimits ?? DEFAULT_OUTPUT_LIMITS
  }

  async run(
    queued: QueuedPreviewJob,
    options: PreviewJobRunOptions = {},
  ): Promise<void> {
    options.signal?.throwIfAborted()
    if (
      !(await this.controlPlane.startWorkerJob(
        queued.jobId,
        options.recovered,
        options.abandon,
      ))
    )
      return
    let workspace: PreviewWorkspace | undefined
    const controller = new AbortController()
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal
    let timedOut = false
    let stopped = false
    let poll: ReturnType<typeof setTimeout> | undefined
    let checking: Promise<void> | undefined
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort(new Error("Preview job exceeded its total time limit."))
    }, this.options.totalJobTimeoutMs ?? DEFAULT_RUNNER_TIMEOUTS.totalJobTimeoutMs)
    timeout.unref()
    const check = async () => {
      try {
        if (!(await this.controlPlane.isWorkerJobActive(queued.jobId)))
          controller.abort()
      } catch {
        // Losing contact with the control plane must stop untrusted execution.
        controller.abort(new Error("Preview control plane unavailable."))
      }
      if (!stopped && !signal.aborted) schedule()
    }
    const schedule = () => {
      poll = setTimeout(() => {
        checking = check()
      }, this.options.cancellationPollMs ?? 500)
      poll.unref()
    }
    schedule()
    try {
      workspace = await this.sandbox.allocate(queued.jobId)
      signal.throwIfAborted()
      await this.runPipeline(queued, workspace, signal)
    } catch (error) {
      // Propagate persistence failures to the queue so they are retried, never silently acknowledged.
      await this.controlPlane.failWorkerJob(
        queued.jobId,
        timedOut
          ? "RUNNER_TIMEOUT"
          : signal.aborted
            ? "RUNNER_UNAVAILABLE"
            : phaseErrorCode(error),
      )
    } finally {
      stopped = true
      clearTimeout(timeout)
      clearTimeout(poll)
      await checking
      try {
        await workspace?.destroy()
      } finally {
        await this.options.cleanup?.(queued)
      }
    }
  }

  private async runPipeline(
    queued: QueuedPreviewJob,
    workspace: PreviewWorkspace,
    signal: AbortSignal,
  ): Promise<void> {
    const { jobId, plan } = queued

    signal.throwIfAborted()
    const archive = await runPhase("FETCH_FAILED", () =>
      this.archiveFetcher.fetch(queued.repository, signal),
    )
    runPhaseSync("FETCH_FAILED", () =>
      validateFetchedArchive(archive, this.archiveLimits),
    )

    if (plan.installCommand) {
      signal.throwIfAborted()
      await this.controlPlane.markPhase(jobId, "installing")
      await runPhase("INSTALL_FAILED", () =>
        this.installer.install(workspace, archive, plan, signal),
      )
    }

    if (plan.buildCommand) {
      signal.throwIfAborted()
      await this.controlPlane.markPhase(jobId, "building")
      await runPhase("BUILD_FAILED", () =>
        this.builder.build(workspace, plan, signal),
      )
    }

    signal.throwIfAborted()
    await this.controlPlane.markPhase(jobId, "publishing")
    const output = await runPhase("PUBLISH_FAILED", () =>
      this.outputResolver.resolve(workspace, plan, signal),
    )
    runPhaseSync("PUBLISH_FAILED", () =>
      validateResolvedOutput(output, this.outputLimits),
    )
    const published = await runPhase("PUBLISH_FAILED", () =>
      this.publisher.publish(jobId, output, signal),
    )

    signal.throwIfAborted()
    await this.controlPlane.complete(jobId, published.artifactId)
  }
}

class RunnerPhaseError extends Error {
  constructor(
    readonly code: PreviewJobErrorCode,
    cause: unknown,
  ) {
    super(
      cause instanceof Error ? cause.message : "Preview runner phase failed.",
    )
    this.name = "RunnerPhaseError"
  }
}

async function runPhase<T>(
  code: PreviewJobErrorCode,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action()
  } catch (error) {
    throw new RunnerPhaseError(
      error instanceof RunnerDiskLimitError ? "RUNNER_DISK_LIMIT" : code,
      error,
    )
  }
}

function runPhaseSync<T>(code: PreviewJobErrorCode, action: () => T): T {
  try {
    return action()
  } catch (error) {
    throw new RunnerPhaseError(code, error)
  }
}

function phaseErrorCode(error: unknown): PreviewJobErrorCode {
  return error instanceof RunnerPhaseError ? error.code : "RUNNER_UNAVAILABLE"
}
