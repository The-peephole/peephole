import { readFile } from "node:fs/promises"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { buildOciRuntimeSpec } from "../services/preview-worker/gvisor/ociConfig"
import { GVisorSandboxProvisioner } from "../services/preview-worker/gvisor/gvisorSandboxProvisioner"
import { RunscCommandRunner } from "../services/preview-worker/gvisor/runscCommandRunner"
import type {
  ProcessRunner,
  ProcessRunResult,
} from "../services/preview-worker/gvisor/processRunner"
import { runscDeleteArgs, runscKillArgs, runscRunArgs } from "../services/preview-worker/gvisor/runscCli"

describe("buildOciRuntimeSpec", () => {
  it("produces a non-root, capability-stripped, quota'd spec", () => {
    const spec = buildOciRuntimeSpec({
      command: ["npm", "ci"],
      cwd: "/workspace",
      env: ["PATH=/usr/bin"],
      uid: 65534,
      gid: 65534,
      hostname: "peephole-preview",
      resourceLimits: { cpuCount: 1, memoryBytes: 1_073_741_824, maxPids: 128 },
    })

    expect(spec.process.user).toEqual({ uid: 65534, gid: 65534 })
    expect(spec.process.noNewPrivileges).toBe(true)
    expect(spec.process.capabilities.bounding).toEqual([])
    expect(spec.linux.resources.cpu).toEqual({ quota: 100_000, period: 100_000 })
    expect(spec.linux.resources.memory).toEqual({ limit: 1_073_741_824 })
    expect(spec.linux.resources.pids).toEqual({ limit: 128 })
    expect(spec.linux.namespaces.map((ns) => ns.type)).toEqual(
      expect.arrayContaining(["pid", "network", "ipc", "uts", "mount"]),
    )
  })
})

describe("runsc CLI argument construction", () => {
  const global = { runscRootDir: "/var/run/peephole/runsc" }

  it("builds run/kill/delete argv without a shell", () => {
    expect(
      runscRunArgs(global, {
        bundleDir: "/var/lib/peephole/jobs/job-1/bundle",
        containerId: "job-1-abcd",
        network: "none",
      }),
    ).toEqual([
      "--root",
      "/var/run/peephole/runsc",
      "--network=none",
      "run",
      "--bundle",
      "/var/lib/peephole/jobs/job-1/bundle",
      "job-1-abcd",
    ])

    expect(runscKillArgs(global, "job-1-abcd")).toEqual([
      "--root",
      "/var/run/peephole/runsc",
      "kill",
      "job-1-abcd",
      "SIGKILL",
    ])

    expect(runscDeleteArgs(global, "job-1-abcd")).toEqual([
      "--root",
      "/var/run/peephole/runsc",
      "delete",
      "--force",
      "job-1-abcd",
    ])
  })
})

class FakeProcessRunner implements ProcessRunner {
  readonly calls: Array<{ command: string; args: string[] }> = []

  constructor(
    private readonly result: ProcessRunResult = {
      exitCode: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
    },
  ) {}

  async run(command: string, args: string[]): Promise<ProcessRunResult> {
    this.calls.push({ command, args })
    return this.result
  }
}

describe("GVisorSandboxProvisioner + RunscCommandRunner (fake runsc)", () => {
  let baseRootfsImage: string
  let bundlesRootDir: string

  beforeEach(async () => {
    baseRootfsImage = await mkdtemp(path.join(os.tmpdir(), "peephole-base-rootfs-"))
    bundlesRootDir = await mkdtemp(path.join(os.tmpdir(), "peephole-bundles-"))
  })

  afterEach(async () => {
    await rm(baseRootfsImage, { recursive: true, force: true })
    await rm(bundlesRootDir, { recursive: true, force: true })
  })

  it("allocates a bundle with a /workspace rootDir and writes an OCI config before running", async () => {
    const processRunner = new FakeProcessRunner()
    const provisioner = new GVisorSandboxProvisioner({
      baseRootfsImage,
      bundlesRootDir,
      processRunner,
    })
    const workspace = await provisioner.allocate("job-1")

    expect(workspace.rootDir.endsWith(path.join("rootfs", "workspace"))).toBe(
      true,
    )

    const runner = new RunscCommandRunner({ processRunner })
    await runner.run(workspace, "npm", ["ci"], { timeoutMs: 5_000 })

    expect(processRunner.calls).toHaveLength(2) // run, then delete
    expect(processRunner.calls[0]?.command).toBe("runsc")
    expect(processRunner.calls[0]?.args).toContain("run")
    expect(processRunner.calls[1]?.args).toContain("delete")

    const configPath = path.join(
      (workspace as unknown as { bundleDir: string }).bundleDir,
      "config.json",
    )
    const config = JSON.parse(await readFile(configPath, "utf8"))
    expect(config.process.args).toEqual(["npm", "ci"])
    expect(config.process.user).toEqual({ uid: 65534, gid: 65534 })

    await workspace.destroy()
  })

  it("throws and still deletes the container when the sandboxed command fails", async () => {
    const processRunner = new FakeProcessRunner({
      exitCode: 1,
      timedOut: false,
      stdout: "",
      stderr: "boom",
    })
    const provisioner = new GVisorSandboxProvisioner({
      baseRootfsImage,
      bundlesRootDir,
      processRunner,
    })
    const workspace = await provisioner.allocate("job-2")
    const runner = new RunscCommandRunner({ processRunner })

    await expect(
      runner.run(workspace, "npm", ["run", "build"], { timeoutMs: 5_000 }),
    ).rejects.toThrow("exited with code 1")

    expect(processRunner.calls.at(-1)?.args).toContain("delete")

    await workspace.destroy()
  })

  it("destroy() sweeps every container it ever started and is idempotent", async () => {
    const processRunner = new FakeProcessRunner()
    const provisioner = new GVisorSandboxProvisioner({
      baseRootfsImage,
      bundlesRootDir,
      processRunner,
    })
    const workspace = await provisioner.allocate("job-3")
    const runner = new RunscCommandRunner({ processRunner })

    await runner.run(workspace, "npm", ["ci"], { timeoutMs: 5_000 })
    await runner.run(workspace, "npm", ["run", "build"], { timeoutMs: 5_000 })

    processRunner.calls.length = 0
    await workspace.destroy()

    const killAndDeleteCalls = processRunner.calls.filter(
      (call) => call.args.includes("kill") || call.args.includes("delete"),
    )
    expect(killAndDeleteCalls).toHaveLength(4) // kill+delete per container

    await workspace.destroy() // idempotent: no crash, no duplicate work
    expect(processRunner.calls).toHaveLength(4)
  })
})
