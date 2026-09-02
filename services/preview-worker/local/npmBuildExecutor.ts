import { DEFAULT_ARCHIVE_LIMITS } from "../../../core/runner/archivePolicy"
import { DEFAULT_RUNNER_TIMEOUTS } from "../../../core/runner/runnerLimits"
import type { BuildPlan } from "../../../types/preview"
import type { BuildExecutor, PreviewWorkspace } from "../ports"
import type { CommandRunner } from "./commandRunner"
import { directorySizeExceeds } from "./directorySize"
import { assertTimeRemaining, effectiveTimeoutMs } from "./jobDeadline"
import { asLocalWorkspace } from "./localWorkspace"
import { minimalNpmEnv } from "./npmDependencyInstaller"
import { resolveNpmExecutable } from "./npmCommand"

export interface NpmBuildExecutorOptions {
  timeoutMs?: number
  maxWorkspaceBytes?: number
}

export class NpmBuildExecutor implements BuildExecutor {
  constructor(
    private readonly commandRunner: CommandRunner,
    private readonly options: NpmBuildExecutorOptions = {},
  ) {}

  async build(workspace: PreviewWorkspace, plan: BuildPlan): Promise<void> {
    if (plan.buildCommand !== "npm run build") {
      throw new Error(`Unexpected build command: ${String(plan.buildCommand)}`)
    }

    const local = asLocalWorkspace(workspace)
    assertTimeRemaining(local)

    await this.commandRunner.run(local, resolveNpmExecutable(), ["run", "build"], {
      timeoutMs: effectiveTimeoutMs(
        local,
        this.options.timeoutMs ?? DEFAULT_RUNNER_TIMEOUTS.buildTimeoutMs,
      ),
      env: minimalNpmEnv(),
    })

    if (
      await directorySizeExceeds(
        local.rootDir,
        this.options.maxWorkspaceBytes ?? DEFAULT_ARCHIVE_LIMITS.maxExpandedBytes,
      )
    ) {
      throw new Error("Build output exceeds the workspace size limit.")
    }
  }
}
