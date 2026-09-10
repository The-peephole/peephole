import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
import {
  runscDeleteArgs,
  runscKillArgs,
  runscRunArgs,
} from "../services/preview-worker/gvisor/runscCli"
import { FakeSandboxDiskManager } from "./fakeSandboxDiskManager"
import { RunnerDiskLimitError } from "../services/preview-worker/local/commandRunner"

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
      dnsConfigSource: "/run/systemd/resolve/resolv.conf",
      workspaceSource: "/var/lib/peephole/jobs/owned/workspace",
    })

    expect(spec.process.user).toEqual({ uid: 65534, gid: 65534 })
    expect(spec.mounts).toContainEqual({
      destination: "/etc/resolv.conf",
      type: "bind",
      source: "/run/systemd/resolve/resolv.conf",
      options: ["bind", "ro"],
    })
    expect(spec.process.noNewPrivileges).toBe(true)
    expect(spec.root.readonly).toBe(true)
    expect(spec.mounts).toContainEqual({
      destination: "/workspace",
      type: "bind",
      source: "/var/lib/peephole/jobs/owned/workspace",
      options: ["rbind", "rw", "nosuid", "nodev"],
    })
    expect(
      spec.mounts.find((mount) => mount.destination === "/tmp")?.options,
    ).toEqual(expect.arrayContaining(["size=67108864", "nr_inodes=16384"]))
    expect(
      spec.mounts.find((mount) => mount.destination === "/dev")?.options,
    ).toEqual(["nosuid", "noexec", "mode=755"])
    expect(
      spec.mounts.find((mount) => mount.destination === "/dev/shm")?.options,
    ).toEqual(
      expect.arrayContaining(["size=16777216", "nr_inodes=4096", "mode=1777"]),
    )
    expect(spec.linux.maskedPaths).toContain("/dev/mqueue")
    expect(spec.process.capabilities.bounding).toEqual(["CAP_NET_BIND_SERVICE"])
    expect(spec.linux.resources.cpu).toEqual({
      quota: 100_000,
      period: 100_000,
    })
    expect(spec.linux.resources.memory).toEqual({
      limit: 1_073_741_824,
      swap: 1_073_741_824,
    })
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
      "--overlay2=none",
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
    return args.includes("run")
      ? this.result
      : { exitCode: 0, timedOut: false, stdout: "", stderr: "" }
  }
}

describe("GVisorSandboxProvisioner + RunscCommandRunner (fake runsc)", () => {
  let baseRootfsImage: string
  let bundlesRootDir: string

  beforeEach(async () => {
    baseRootfsImage = await mkdtemp(
      path.join(os.tmpdir(), "peephole-base-rootfs-"),
    )
    await writeFile(path.join(baseRootfsImage, "base-file"), "trusted-rootfs")
    bundlesRootDir = await mkdtemp(path.join(os.tmpdir(), "peephole-bundles-"))
  })

  afterEach(async () => {
    await rm(baseRootfsImage, { recursive: true, force: true })
    await rm(bundlesRootDir, { recursive: true, force: true })
  })

  it("allocates a bundle with a /workspace rootDir and writes an OCI config before running", async () => {
    const processRunner = new FakeProcessRunner()
    const diskManager = new FakeSandboxDiskManager(bundlesRootDir)
    const provisioner = new GVisorSandboxProvisioner({
      baseRootfsImage,
      bundlesRootDir,
      processRunner,
      diskManager,
    })
    const workspace = await provisioner.allocate("job-1")

    expect(workspace.rootDir.endsWith("workspace")).toBe(true)
    expect(workspace.archiveStagingRoot).toBe(
      path.join(workspace.bundleDir, "staging"),
    )
    expect(workspace.archiveStagingRoot?.startsWith(workspace.rootDir)).toBe(
      false,
    )
    expect(diskManager.createOptions[0]?.expectedOutsideBytes).toBeGreaterThan(
      150 * 1024 * 1024,
    )
    expect(diskManager.reservationUpdates).toEqual([150 * 1024 * 1024])

    const runner = new RunscCommandRunner({ processRunner })
    await runner.run(workspace, "npm", ["ci"], {
      timeoutMs: 5_000,
      env: { HOME: "/var/tmp", TEMP: "/var/tmp" },
    })

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
    expect(config.root.readonly).toBe(true)
    expect(config.process.env).toContain("HOME=/workspace/.home")
    expect(config.process.env).toContain("TEMP=/tmp")
    expect(config.process.env).not.toContain("HOME=/var/tmp")

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
      diskManager: new FakeSandboxDiskManager(bundlesRootDir),
    })
    const workspace = await provisioner.allocate("job-2")
    const runner = new RunscCommandRunner({ processRunner })

    await expect(
      runner.run(workspace, "npm", ["run", "build"], { timeoutMs: 5_000 }),
    ).rejects.toThrow("exited with code 1")

    expect(processRunner.calls.at(-1)?.args).toContain("delete")

    await workspace.destroy()
  })

  it("does not infer disk exhaustion from stderr or a post-failure statfs snapshot", async () => {
    const processRunner = new FakeProcessRunner({
      exitCode: 1,
      timedOut: false,
      stdout: "",
      stderr: "ENOSPC",
    })
    const provisioner = new GVisorSandboxProvisioner({
      baseRootfsImage,
      bundlesRootDir,
      processRunner,
      diskManager: new FakeSandboxDiskManager(bundlesRootDir),
    })
    const workspace = await provisioner.allocate("job-disk-classification")
    const runner = new RunscCommandRunner({ processRunner })

    await expect(
      runner.run(workspace, "npm", ["ci"], { timeoutMs: 5_000 }),
    ).rejects.not.toBeInstanceOf(RunnerDiskLimitError)

    await workspace.destroy()
  })

  it("destroy() sweeps every container it ever started and is idempotent", async () => {
    const processRunner = new FakeProcessRunner()
    const provisioner = new GVisorSandboxProvisioner({
      baseRootfsImage,
      bundlesRootDir,
      processRunner,
      diskManager: new FakeSandboxDiskManager(bundlesRootDir),
    })
    const workspace = await provisioner.allocate("job-3")
    const runner = new RunscCommandRunner({ processRunner })

    await runner.run(workspace, "npm", ["ci"], { timeoutMs: 5_000 })
    await runner.run(workspace, "npm", ["run", "build"], { timeoutMs: 5_000 })
    expect(workspace.listContainers()).toEqual([])
    workspace.registerContainer("abandoned-a")
    workspace.registerContainer("abandoned-b")

    processRunner.calls.length = 0
    await workspace.destroy()

    const killAndDeleteCalls = processRunner.calls.filter(
      (call) => call.args.includes("kill") || call.args.includes("delete"),
    )
    expect(killAndDeleteCalls).toHaveLength(4) // kill+delete per container

    await workspace.destroy() // idempotent: no crash, no duplicate work
    expect(processRunner.calls).toHaveLength(4)
  })

  it("kills a container early once the workspace grows past the size limit, instead of waiting for it to exit on its own", async () => {
    class WatchableProcessRunner implements ProcessRunner {
      readonly calls: Array<{ command: string; args: string[] }> = []
      private resolveRun?: (result: ProcessRunResult) => void

      async run(command: string, args: string[]): Promise<ProcessRunResult> {
        this.calls.push({ command, args })
        if (args.includes("kill")) {
          this.resolveRun?.({
            exitCode: 137,
            timedOut: false,
            stdout: "",
            stderr: "",
          })
          return { exitCode: 0, timedOut: false, stdout: "", stderr: "" }
        }
        if (args.includes("run")) {
          // Never resolves on its own within this test's timeout -- only
          // the disk-quota watcher's kill (above) unblocks it, proving
          // the kill happens *during* the run rather than after some
          // other completion path.
          return new Promise((resolve) => {
            this.resolveRun = resolve
          })
        }
        return { exitCode: 0, timedOut: false, stdout: "", stderr: "" }
      }
    }

    const processRunner = new WatchableProcessRunner()
    const provisioner = new GVisorSandboxProvisioner({
      baseRootfsImage,
      bundlesRootDir,
      processRunner,
      diskManager: new FakeSandboxDiskManager(bundlesRootDir),
    })
    const workspace = await provisioner.allocate("job-quota")
    const runner = new RunscCommandRunner({
      processRunner,
      maxWorkspaceBytes: 10,
      diskQuotaPollMs: 20,
    })

    // Already over the 10-byte limit before run() is even called, so the
    // watcher's very first poll tick should trip it.
    await writeFile(path.join(workspace.rootDir, "big.bin"), Buffer.alloc(1000))

    await expect(
      runner.run(workspace, "npm", ["ci"], { timeoutMs: 5_000 }),
    ).rejects.toThrow(/workspace size limit/)

    expect(processRunner.calls.some((call) => call.args.includes("kill"))).toBe(
      true,
    )

    await workspace.destroy()
  }, 10_000)
})
