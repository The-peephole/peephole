import type { PreviewJobErrorCode, QueuedPreviewJob } from "../../types/preview"
import {
  DEFAULT_ARCHIVE_LIMITS,
  DEFAULT_OUTPUT_LIMITS,
  validateFetchedArchive,
  validateResolvedOutput,
  type ArchiveLimits,
  type OutputLimits,
} from "../../core/runner/archivePolicy"
import type { PreviewControlPlane } from "../preview-api/controlPlane"
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
    options: PreviewJobWorkerOptions = {},
  ) {
    this.archiveLimits = options.archiveLimits ?? DEFAULT_ARCHIVE_LIMITS
    this.outputLimits = options.outputLimits ?? DEFAULT_OUTPUT_LIMITS
  }

  async run(queued: QueuedPreviewJob): Promise<void> {
    let workspace: PreviewWorkspace

    try {
      workspace = await this.sandbox.allocate(queued.jobId)
    } catch {
      await this.controlPlane
        .fail(queued.jobId, "RUNNER_UNAVAILABLE")
        .catch(() => undefined)
      return
    }

    try {
      await this.runPipeline(queued, workspace)
    } catch (error) {
      await this.controlPlane
        .fail(queued.jobId, phaseErrorCode(error))
        .catch(() => undefined)
    } finally {
      await workspace.destroy().catch(() => undefined)
    }
  }

  private async runPipeline(
    queued: QueuedPreviewJob,
    workspace: PreviewWorkspace,
  ): Promise<void> {
    const { jobId, plan } = queued

    await this.controlPlane.markPhase(jobId, "fetching")
    const archive = await runPhase("FETCH_FAILED", () =>
      this.archiveFetcher.fetch(queued.repository),
    )
    runPhaseSync("FETCH_FAILED", () =>
      validateFetchedArchive(archive, this.archiveLimits),
    )

    if (plan.installCommand) {
      await this.controlPlane.markPhase(jobId, "installing")
      await runPhase("INSTALL_FAILED", () =>
        this.installer.install(workspace, archive, plan),
      )
    }

    if (plan.buildCommand) {
      await this.controlPlane.markPhase(jobId, "building")
      await runPhase("BUILD_FAILED", () => this.builder.build(workspace, plan))
    }

    await this.controlPlane.markPhase(jobId, "publishing")
    const output = await runPhase("PUBLISH_FAILED", () =>
      this.outputResolver.resolve(workspace, plan),
    )
    runPhaseSync("PUBLISH_FAILED", () =>
      validateResolvedOutput(output, this.outputLimits),
    )
    const published = await runPhase("PUBLISH_FAILED", () =>
      this.publisher.publish(jobId, output),
    )

    await this.controlPlane.complete(jobId, published.artifactId)
  }
}

class RunnerPhaseError extends Error {
  constructor(readonly code: PreviewJobErrorCode, cause: unknown) {
    super(cause instanceof Error ? cause.message : "Preview runner phase failed.")
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
    throw new RunnerPhaseError(code, error)
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
