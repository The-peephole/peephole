import { writeFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { ArchiveByteStore } from "../services/preview-worker/local/archiveByteStore"
import type {
  CommandRunner,
  CommandRunOptions,
} from "../services/preview-worker/local/commandRunner"
import { ExtractionState } from "../services/preview-worker/local/extractionState"
import { LocalDevSandboxProvisioner } from "../services/preview-worker/local/localDevSandboxProvisioner"
import type { LocalPreviewWorkspace } from "../services/preview-worker/local/localWorkspace"
import { NpmBuildExecutor } from "../services/preview-worker/local/npmBuildExecutor"
import { NpmDependencyInstaller } from "../services/preview-worker/local/npmDependencyInstaller"
import type { BuildPlan } from "../types/preview"
import type { FetchedArchive } from "../types/runner"

const repository = {
  repositoryId: 1,
  owner: "acme",
  name: "web",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
}

const plan: BuildPlan = {
  contractVersion: "static-v1",
  repository,
  sourceRoot: ".",
  packageManager: "npm",
  installCommand: "npm ci",
  buildCommand: "npm run build",
  outputDirectory: "dist",
}

const emptyArchive: FetchedArchive = { compressedBytes: 0, entries: [] }

class ThrowingCommandRunner implements CommandRunner {
  async run(): Promise<void> {
    throw new Error("should never be invoked")
  }
}

class RecordingCommandRunner implements CommandRunner {
  readonly seenTimeoutMs: number[] = []

  constructor(
    private readonly onRun?: (workspace: LocalPreviewWorkspace) => Promise<void>,
  ) {}

  async run(
    workspace: LocalPreviewWorkspace | unknown,
    _command: string,
    _args: string[],
    options: CommandRunOptions,
  ): Promise<void> {
    this.seenTimeoutMs.push(options.timeoutMs)
    await this.onRun?.(workspace as LocalPreviewWorkspace)
  }
}

describe("job wall-clock budget enforcement", () => {
  it("NpmDependencyInstaller fails fast, before extraction, when the budget is already exhausted", async () => {
    const provisioner = new LocalDevSandboxProvisioner({ jobTimeoutMs: -1 })
    const workspace = await provisioner.allocate("job-install-expired")
    const installer = new NpmDependencyInstaller(
      new ArchiveByteStore(),
      new ExtractionState(),
      new ThrowingCommandRunner(),
    )

    await expect(
      installer.install(workspace, emptyArchive, plan),
    ).rejects.toThrow("exceeded its total time budget")

    await workspace.destroy()
  })

  it("NpmBuildExecutor fails fast when the budget is already exhausted", async () => {
    const provisioner = new LocalDevSandboxProvisioner({ jobTimeoutMs: -1 })
    const workspace = await provisioner.allocate("job-build-expired")
    const builder = new NpmBuildExecutor(new ThrowingCommandRunner())

    await expect(builder.build(workspace, plan)).rejects.toThrow(
      "exceeded its total time budget",
    )

    await workspace.destroy()
  })

  it("caps the command timeout to the job's remaining budget, not the per-command default", async () => {
    const fixedNow = new Date("2026-09-01T00:00:00.000Z")
    const provisioner = new LocalDevSandboxProvisioner({
      jobTimeoutMs: 5_000, // far below the 120s per-command default
      now: () => fixedNow,
    })
    const workspace = await provisioner.allocate("job-tight-budget")
    const commandRunner = new RecordingCommandRunner()
    const builder = new NpmBuildExecutor(commandRunner)

    await builder.build(workspace, plan)

    expect(commandRunner.seenTimeoutMs[0]).toBe(5_000)

    await workspace.destroy()
  })
})

describe("workspace disk-usage quota enforcement", () => {
  it("NpmBuildExecutor rejects once the workspace exceeds the configured size limit after a successful build", async () => {
    const provisioner = new LocalDevSandboxProvisioner()
    const workspace = await provisioner.allocate("job-oversized-build")
    const commandRunner = new RecordingCommandRunner(async (ws) => {
      // The fake "build" writes more than the (tiny, test-only) limit.
      await writeFile(path.join(ws.rootDir, "huge.bin"), Buffer.alloc(200, 1))
    })
    const builder = new NpmBuildExecutor(commandRunner, {
      maxWorkspaceBytes: 100,
    })

    await expect(builder.build(workspace, plan)).rejects.toThrow(
      "exceeds the workspace size limit",
    )

    await workspace.destroy()
  })

  it("NpmBuildExecutor succeeds when the build output stays within the configured limit", async () => {
    const provisioner = new LocalDevSandboxProvisioner()
    const workspace = await provisioner.allocate("job-normal-build")
    const commandRunner = new RecordingCommandRunner(async (ws) => {
      await writeFile(path.join(ws.rootDir, "small.bin"), Buffer.alloc(50, 1))
    })
    const builder = new NpmBuildExecutor(commandRunner, {
      maxWorkspaceBytes: 100,
    })

    await expect(builder.build(workspace, plan)).resolves.toBeUndefined()

    await workspace.destroy()
  })
})
