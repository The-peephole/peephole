import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer, type Server } from "node:net"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  BackendRuntimeExitedBeforeReadyError,
  BackendRuntimeReadinessTimeoutError,
  GVisorBackendRuntimeProcess,
} from "../services/preview-worker/gvisor/backendRuntimeProcess"
import type { GVisorPreviewWorkspace } from "../services/preview-worker/gvisor/gvisorWorkspace"
import type {
  ProcessRunner,
  ProcessRunResult,
} from "../services/preview-worker/gvisor/processRunner"
import type { BackendRuntimePlan } from "../types/backendRuntime"

const plan: BackendRuntimePlan = {
  contractVersion: "backend-v1",
  repository: {
    repositoryId: 1,
    owner: "acme",
    name: "web",
    commitSha: "a".repeat(40),
  },
  sourceRoot: "backend",
  adapterId: "express-node-npm-v1",
  packageManager: "npm",
  install: { command: "npm", args: ["ci"] },
  start: { command: "node", args: ["src/server.js"] },
  internalPort: 3000,
  platformEnvironment: {
    PORT: "3000",
    HOST: "0.0.0.0",
    NODE_ENV: "production",
  },
}

class FakeProcessRunner implements ProcessRunner {
  readonly calls: Array<{ command: string; args: string[] }> = []
  private runResolve: ((result: ProcessRunResult) => void) | null = null
  crashResult: ProcessRunResult | null = null
  killResult: ProcessRunResult = {
    exitCode: 0,
    timedOut: false,
    stdout: "",
    stderr: "",
  }
  deleteResult: ProcessRunResult = {
    exitCode: 0,
    timedOut: false,
    stdout: "",
    stderr: "",
  }
  killThrows = false

  async run(command: string, args: string[]): Promise<ProcessRunResult> {
    this.calls.push({ command, args })
    if (args.includes("kill")) {
      if (this.killThrows) throw new Error("kill failed")
      if (this.killResult.exitCode === 0 && !this.killResult.timedOut) {
        this.runResolve?.({
          exitCode: 137,
          timedOut: false,
          stdout: "",
          stderr: "",
        })
        this.runResolve = null
      }
      return this.killResult
    }
    if (args.includes("delete")) {
      return this.deleteResult
    }
    if (args.includes("run")) {
      if (this.crashResult) return this.crashResult
      return new Promise<ProcessRunResult>((resolve) => {
        this.runResolve = resolve
      })
    }
    return { exitCode: 0, timedOut: false, stdout: "", stderr: "" }
  }
}

function fakeWorkspace(
  bundleDir: string,
  peerIp: string,
): GVisorPreviewWorkspace {
  const containers = new Set<string>()
  return {
    id: "job-backend",
    rootDir: path.join(bundleDir, "rootfs", "workspace"),
    bundleDir,
    remainingMs: () => 60_000,
    normalizeExtractedTree: async () => undefined,
    destroy: async () => undefined,
    registerContainer: (id) => containers.add(id),
    unregisterContainer: (id) => containers.delete(id),
    listContainers: () => Array.from(containers),
    ensureNetworkNamespace: async () => "/var/run/netns/fake-egress",
    ensureIngressOnlyNetworkNamespace: async () => ({
      path: "/var/run/netns/fake-ingress",
      peerIp,
    }),
  }
}

describe("GVisorBackendRuntimeProcess", () => {
  let server: Server
  let port: number
  let bundleDir: string

  beforeEach(async () => {
    server = createServer((socket) => socket.end())
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (!address || typeof address === "string") {
      throw new Error("Expected a bound TCP address.")
    }
    port = address.port
    bundleDir = await mkdtemp(
      path.join(os.tmpdir(), "peephole-backend-runtime-"),
    )
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(bundleDir, { recursive: true, force: true })
  })

  it("becomes ready once the internal port accepts a connection", async () => {
    const processRunner = new FakeProcessRunner()
    const runtime = new GVisorBackendRuntimeProcess({
      processRunner,
      resolveDnsConfig: () => ({ source: "/etc/resolv.conf", nameservers: [] }),
    })
    const handle = await runtime.start(fakeWorkspace(bundleDir, "127.0.0.1"), {
      ...plan,
      internalPort: port,
    })

    await expect(handle.waitUntilReady(2_000)).resolves.toBeUndefined()

    await handle.stop()
    expect(processRunner.calls.some((call) => call.args.includes("kill"))).toBe(
      true,
    )
    expect(
      processRunner.calls.some((call) => call.args.includes("delete")),
    ).toBe(true)
  })

  it("exposes an internal dial target matching the provisioned ingress-only peerIp and the plan's own internalPort", async () => {
    const processRunner = new FakeProcessRunner()
    const runtime = new GVisorBackendRuntimeProcess({
      processRunner,
      resolveDnsConfig: () => ({ source: "/etc/resolv.conf", nameservers: [] }),
    })
    const distinctPeerIp = "10.201.7.2"
    const handle = await runtime.start(
      fakeWorkspace(bundleDir, distinctPeerIp),
      { ...plan, internalPort: 4321 },
    )

    expect(handle.dialTarget).toEqual({ host: distinctPeerIp, port: 4321 })

    await handle.stop()
  })

  it("registers then unregisters the container across the full lifecycle", async () => {
    const processRunner = new FakeProcessRunner()
    const runtime = new GVisorBackendRuntimeProcess({
      processRunner,
      resolveDnsConfig: () => ({ source: "/etc/resolv.conf", nameservers: [] }),
    })
    const workspace = fakeWorkspace(bundleDir, "127.0.0.1")
    const handle = await runtime.start(workspace, {
      ...plan,
      internalPort: port,
    })

    expect(workspace.listContainers()).toHaveLength(1)
    await handle.stop()
    expect(workspace.listContainers()).toHaveLength(0)
  })

  it("throws a distinct error when the process exits before ever becoming ready", async () => {
    const processRunner = new FakeProcessRunner()
    processRunner.crashResult = {
      exitCode: 1,
      timedOut: false,
      stdout: "",
      stderr: "",
    }
    const runtime = new GVisorBackendRuntimeProcess({ processRunner })
    const handle = await runtime.start(fakeWorkspace(bundleDir, "127.0.0.1"), {
      ...plan,
      // Nothing listens here -- the crash must be what fails this, not a
      // readiness timeout racing a port that happens to be reachable.
      internalPort: 1,
    })

    await expect(handle.waitUntilReady(2_000)).rejects.toThrow(
      BackendRuntimeExitedBeforeReadyError,
    )
  })

  it("throws a readiness-timeout error when nothing is listening on the port", async () => {
    const processRunner = new FakeProcessRunner()
    const runtime = new GVisorBackendRuntimeProcess({
      processRunner,
      maxProbeIntervalMs: 50,
    })
    const handle = await runtime.start(fakeWorkspace(bundleDir, "127.0.0.1"), {
      ...plan,
      internalPort: 1, // Reserved; nothing should ever be listening here.
    })

    await expect(handle.waitUntilReady(200)).rejects.toThrow(
      BackendRuntimeReadinessTimeoutError,
    )
    await handle.stop()
  })

  it("waitForExit resolves and cleans up once the process exits on its own", async () => {
    const processRunner = new FakeProcessRunner()
    processRunner.crashResult = {
      exitCode: 137,
      timedOut: false,
      stdout: "",
      stderr: "",
    }
    const runtime = new GVisorBackendRuntimeProcess({ processRunner })
    const workspace = fakeWorkspace(bundleDir, "127.0.0.1")
    const handle = await runtime.start(workspace, {
      ...plan,
      internalPort: port,
    })

    const result = await handle.waitForExit()

    expect(result.exitCode).toBe(137)
    expect(workspace.listContainers()).toHaveLength(0)
    expect(
      processRunner.calls.some((call) => call.args.includes("delete")),
    ).toBe(true)
    // A process that already exited on its own was never sent a kill.
    expect(processRunner.calls.some((call) => call.args.includes("kill"))).toBe(
      false,
    )
  })

  it("stop() is idempotent and only deletes the container once", async () => {
    const processRunner = new FakeProcessRunner()
    const runtime = new GVisorBackendRuntimeProcess({ processRunner })
    const handle = await runtime.start(fakeWorkspace(bundleDir, "127.0.0.1"), {
      ...plan,
      internalPort: port,
    })

    await handle.stop()
    await handle.stop()

    expect(
      processRunner.calls.filter((call) => call.args.includes("delete")),
    ).toHaveLength(1)
  })

  it.each([
    {
      label: "returns non-zero",
      configure: (runner: FakeProcessRunner) => {
        runner.killResult = {
          exitCode: 1,
          timedOut: false,
          stdout: "",
          stderr: "",
        }
      },
    },
    {
      label: "times out",
      configure: (runner: FakeProcessRunner) => {
        runner.killResult = {
          exitCode: null,
          timedOut: true,
          stdout: "",
          stderr: "",
        }
      },
    },
    {
      label: "throws",
      configure: (runner: FakeProcessRunner) => {
        runner.killThrows = true
      },
    },
  ])(
    "fails stop when runsc kill $label but still force-deletes",
    async ({ configure }) => {
      const processRunner = new FakeProcessRunner()
      configure(processRunner)
      const runtime = new GVisorBackendRuntimeProcess({ processRunner })
      const workspace = fakeWorkspace(bundleDir, "127.0.0.1")
      const handle = await runtime.start(workspace, {
        ...plan,
        internalPort: port,
      })

      await expect(handle.stop()).rejects.toThrow(
        "Backend runtime stop command failed",
      )
      expect(
        processRunner.calls.some((call) => call.args.includes("delete")),
      ).toBe(true)
      expect(workspace.listContainers()).toEqual([])

      await expect(handle.stop()).rejects.toThrow(
        "Backend runtime stop command failed",
      )
      expect(
        processRunner.calls.filter((call) => call.args.includes("kill")),
      ).toHaveLength(1)
      expect(
        processRunner.calls.filter((call) => call.args.includes("delete")),
      ).toHaveLength(1)
    },
  )

  it("writes an OCI spec that runs the absolute sandbox node binary directly with only the platform env allowlist, never a shell or npm start", async () => {
    const processRunner = new FakeProcessRunner()
    const runtime = new GVisorBackendRuntimeProcess({ processRunner })
    const handle = await runtime.start(fakeWorkspace(bundleDir, "127.0.0.1"), {
      ...plan,
      internalPort: port,
    })
    await handle.stop()

    const config = JSON.parse(
      await readFile(path.join(bundleDir, "config.json"), "utf8"),
    )
    // Exactly ["/usr/local/bin/node", <entrypoint>]: no shell wrapper (a
    // shell would appear as "/bin/sh", "-c", ...), no "npm"/"npm start".
    expect(config.process.args).toEqual([
      "/usr/local/bin/node",
      "src/server.js",
    ])
    expect(config.process.args[0]).not.toMatch(/sh$/)
    expect(config.process.args).not.toContain("npm")
    // Exactly PORT/HOST/NODE_ENV -- no PATH, so a bare command name could
    // never resolve via executable-name lookup even if this regressed.
    expect(config.process.env).toEqual([
      "PORT=3000",
      "HOST=0.0.0.0",
      "NODE_ENV=production",
    ])
    expect(
      (config.process.env as string[]).some((entry) =>
        entry.startsWith("PATH="),
      ),
    ).toBe(false)
    expect(config.process.cwd).toBe("/workspace/backend")
    expect(config.process.user).toEqual({ uid: 65534, gid: 65534 })
    expect(config.linux.namespaces).toContainEqual({
      type: "network",
      path: "/var/run/netns/fake-ingress",
    })
  })

  it('rejects a plan whose start command is not the logical "node" command', async () => {
    // start.command is typed as the literal "node" and is independently
    // validated far upstream by validateBackendRuntimePlan; this proves the
    // runtime's own narrow defense-in-depth check, guarding the translation
    // to the absolute sandbox binary, never silently passes an unexpected
    // command straight into the OCI spec if that upstream guarantee is ever
    // bypassed (e.g. a plan reconstructed from untrusted storage).
    const processRunner = new FakeProcessRunner()
    const runtime = new GVisorBackendRuntimeProcess({ processRunner })
    const tamperedPlan: BackendRuntimePlan = {
      ...plan,
      internalPort: port,
      start: { command: "sh", args: ["src/server.js"] } as unknown as {
        command: "node"
        args: [string]
      },
    }

    await expect(
      runtime.start(fakeWorkspace(bundleDir, "127.0.0.1"), tamperedPlan),
    ).rejects.toThrow('Backend runtime plan start command must be "node".')
  })
})
