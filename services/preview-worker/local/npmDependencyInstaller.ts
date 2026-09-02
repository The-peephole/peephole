import { access } from "node:fs/promises"
import path from "node:path"

import { DEFAULT_ARCHIVE_LIMITS } from "../../../core/runner/archivePolicy"
import { DEFAULT_RUNNER_TIMEOUTS } from "../../../core/runner/runnerLimits"
import type { BuildPlan } from "../../../types/preview"
import type { FetchedArchive } from "../../../types/runner"
import type { DependencyInstaller, PreviewWorkspace } from "../ports"
import type { ArchiveByteStore } from "./archiveByteStore"
import type { CommandRunner } from "./commandRunner"
import { directorySizeExceeds } from "./directorySize"
import type { ExtractionState } from "./extractionState"
import { assertTimeRemaining, effectiveTimeoutMs } from "./jobDeadline"
import { asLocalWorkspace } from "./localWorkspace"
import { resolveNpmExecutable } from "./npmCommand"

export interface NpmDependencyInstallerOptions {
  timeoutMs?: number
  maxWorkspaceBytes?: number
}

/**
 * v0.1 supports npm only. pnpm/yarn/bun plans are rejected here rather than
 * silently attempted -- the analyzer/control-plane may model those package
 * managers, but no real adapter exists for them yet.
 */
export class NpmDependencyInstaller implements DependencyInstaller {
  constructor(
    private readonly byteStore: ArchiveByteStore,
    private readonly extraction: ExtractionState,
    private readonly commandRunner: CommandRunner,
    private readonly options: NpmDependencyInstallerOptions = {},
  ) {}

  async install(
    workspace: PreviewWorkspace,
    _archive: FetchedArchive,
    plan: BuildPlan,
  ): Promise<void> {
    if (plan.packageManager !== "npm") {
      throw new Error(
        `No real installer is implemented for package manager "${plan.packageManager}".`,
      )
    }

    if (plan.installCommand !== "npm ci") {
      throw new Error(`Unexpected install command: ${String(plan.installCommand)}`)
    }

    const local = asLocalWorkspace(workspace)
    assertTimeRemaining(local)

    await this.extraction.ensureExtracted(
      local,
      plan.repository.commitSha,
      this.byteStore,
    )

    const lockfilePath = path.join(local.rootDir, "package-lock.json")

    if (!(await exists(lockfilePath))) {
      throw new Error(
        "package-lock.json is required at the repository root for npm ci.",
      )
    }

    // --ignore-scripts is deliberately NOT set: esbuild's postinstall
    // fetches the platform binary Vite needs to build. Running lifecycle
    // scripts unrestricted is only acceptable because this adapter never
    // touches untrusted content -- see HostCommandRunner's warning.
    await this.commandRunner.run(
      local,
      resolveNpmExecutable(),
      ["ci", "--no-audit", "--no-fund"],
      {
        timeoutMs: effectiveTimeoutMs(
          local,
          this.options.timeoutMs ?? DEFAULT_RUNNER_TIMEOUTS.buildTimeoutMs,
        ),
        env: minimalNpmEnv(),
      },
    )

    if (
      await directorySizeExceeds(
        local.rootDir,
        this.options.maxWorkspaceBytes ?? DEFAULT_ARCHIVE_LIMITS.maxExpandedBytes,
      )
    ) {
      throw new Error(
        "Installed dependencies exceed the workspace size limit.",
      )
    }
  }
}

export function minimalNpmEnv(): Record<string, string> {
  // NODE_ENV is deliberately unset: npm treats "production" as "skip
  // devDependencies", which would drop the build tooling (vite, bundler
  // plugins) that `npm run build` needs.
  const env: Record<string, string> = {
    npm_config_audit: "false",
    npm_config_fund: "false",
  }

  if (process.env.PATH) env.PATH = process.env.PATH
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT
  if (process.env.TEMP) env.TEMP = process.env.TEMP
  if (process.env.TMP) env.TMP = process.env.TMP

  return env
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}
