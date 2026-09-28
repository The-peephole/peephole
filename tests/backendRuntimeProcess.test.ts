import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { createServer, type Server } from "node:net"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  BackendRuntimeExitedBeforeReadyError,
  BackendRuntimeReadinessTimeoutError,
  GVisorBackendRuntimeProcess,
} from "../services/preview-worker/gvisor/backendRuntimeProcess"
import {
  DATABASE_CREDENTIAL_FILE_NAME,
  TmpfsDatabaseCredentialFilesystem,
} from "../services/preview-worker/gvisor/databaseCredentialFilesystem"
import { TmpfsGeneratedSecretFilesystem } from "../services/preview-worker/gvisor/generatedSecretFilesystem"
import {
  TENANT_DATABASE_HOST,
  TENANT_DATABASE_PORT,
} from "../core/backendDatabase/databaseUrl"
import { mintTemporaryDatabaseResourceId } from "../core/backendDatabase/resourceIdentity"
import { createOpaqueSecretValue } from "../core/backendSecrets/generatedSecretValue"
import type { GVisorPreviewWorkspace } from "../services/preview-worker/gvisor/gvisorWorkspace"
import type {
  ProcessRunner,
  ProcessRunResult,
} from "../services/preview-worker/gvisor/processRunner"
import type { BackendRuntimePlan } from "../types/backendRuntime"
import type { GeneratedSecretMaterial } from "../types/backendRuntimeSecrets"
import type { TemporaryDatabaseRuntimeCredentialMaterial } from "../types/temporaryDatabase"

const SECRET_MARKER = "M10BMarker_7Hn9-Q"
const DATABASE_URL_MARKER = `postgresql://pv_x:M11CMarker_7Hn9-Q@${TENANT_DATABASE_HOST}:${String(TENANT_DATABASE_PORT)}/pv_x`

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
  generatedSecretNames: [],
  databaseRequirement: null,
}

const secretPlan: BackendRuntimePlan = {
  ...plan,
  generatedSecretNames: ["SESSION_SECRET"],
}

const databasePlan: BackendRuntimePlan = {
  ...plan,
  databaseRequirement: { name: "DATABASE_URL" },
}

const databaseAndSecretPlan: BackendRuntimePlan = {
  ...secretPlan,
  databaseRequirement: { name: "DATABASE_URL" },
}

function databaseCredential(
  runtimeId = "job-backend",
  url = DATABASE_URL_MARKER,
): TemporaryDatabaseRuntimeCredentialMaterial {
  return {
    runtimeId,
    resourceId: mintTemporaryDatabaseResourceId(() =>
      new Uint8Array(14).fill(5),
    ),
    databaseUrl: createOpaqueSecretValue(url),
  }
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
  /** Models whether the sandboxed process actually reacts to the delivered
   * signal. Real SIGKILL always does; a test proving SIGTERM's bounded grace
   * period sets this to false to model a process that never exits on its
   * own, so `stop()` must still reach `delete --force` within the configured
   * grace bound rather than hanging. */
  killResolvesRun = true

  async run(command: string, args: string[]): Promise<ProcessRunResult> {
    this.calls.push({ command, args })
    if (args.includes("kill")) {
      if (this.killThrows) throw new Error("kill failed")
      if (
        this.killResolvesRun &&
        this.killResult.exitCode === 0 &&
        !this.killResult.timedOut
      ) {
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
  options: {
    ensureIngressOnlyNetworkNamespace?: GVisorPreviewWorkspace["ensureIngressOnlyNetworkNamespace"]
  } = {},
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
    ensureIngressOnlyNetworkNamespace:
      options.ensureIngressOnlyNetworkNamespace ??
      (async () => ({
        path: "/var/run/netns/fake-ingress",
        peerIp,
      })),
  }
}

describe("GVisorBackendRuntimeProcess", () => {
  let server: Server
  let port: number
  let bundleDir: string
  let secretRoot: string
  let dbCredentialRoot: string

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
    secretRoot = await mkdtemp(
      path.join(os.tmpdir(), "peephole-runtime-secrets-"),
    )
    dbCredentialRoot = await mkdtemp(
      path.join(os.tmpdir(), "peephole-runtime-db-credentials-"),
    )
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(bundleDir, { recursive: true, force: true })
    await rm(secretRoot, { recursive: true, force: true })
    await rm(dbCredentialRoot, { recursive: true, force: true })
  })

  function databaseCredentialFilesystem() {
    return new TmpfsDatabaseCredentialFilesystem({
      rootDir: dbCredentialRoot,
      verifyMemoryBackedRoot: async () => undefined,
      setOwnership: async () => undefined,
    })
  }

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

  it("stop() sends SIGTERM, not SIGKILL, so the trusted secret bootstrap can forward it", async () => {
    const processRunner = new FakeProcessRunner()
    const runtime = new GVisorBackendRuntimeProcess({ processRunner })
    const handle = await runtime.start(fakeWorkspace(bundleDir, "127.0.0.1"), {
      ...plan,
      internalPort: port,
    })

    await handle.stop()

    const killCall = processRunner.calls.find((call) =>
      call.args.includes("kill"),
    )
    expect(killCall?.args).toContain("SIGTERM")
    expect(killCall?.args).not.toContain("SIGKILL")
  })

  it("does not wait the full grace period once the process exits promptly", async () => {
    const processRunner = new FakeProcessRunner()
    const runtime = new GVisorBackendRuntimeProcess({
      processRunner,
      stopGraceMs: 5_000,
    })
    const handle = await runtime.start(fakeWorkspace(bundleDir, "127.0.0.1"), {
      ...plan,
      internalPort: port,
    })

    const startedAt = Date.now()
    await handle.stop()

    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  it("still force-deletes after a bounded grace period when the process never exits", async () => {
    const processRunner = new FakeProcessRunner()
    processRunner.killResolvesRun = false
    const runtime = new GVisorBackendRuntimeProcess({
      processRunner,
      stopGraceMs: 20,
    })
    const handle = await runtime.start(fakeWorkspace(bundleDir, "127.0.0.1"), {
      ...plan,
      internalPort: port,
    })

    const startedAt = Date.now()
    await handle.stop()

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20)
    expect(
      processRunner.calls.some((call) => call.args.includes("delete")),
    ).toBe(true)
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
    expect(
      config.mounts.filter((mount: { destination: string }) =>
        mount.destination.startsWith("/run/secrets"),
      ),
    ).toEqual([])
    expect(config.process.user).toEqual({ uid: 65534, gid: 65534 })
    expect(config.linux.namespaces).toContainEqual({
      type: "network",
      path: "/var/run/netns/fake-ingress",
    })
  })

  it("injects through one read-only mount and trusted bootstrap without serializing the secret", async () => {
    const processRunner = new FakeProcessRunner()
    const generatedSecretFilesystem = new TmpfsGeneratedSecretFilesystem({
      rootDir: secretRoot,
      verifyMemoryBackedRoot: async () => undefined,
      setOwnership: async () => undefined,
    })
    const runtime = new GVisorBackendRuntimeProcess({
      processRunner,
      generatedSecretFilesystem,
    })
    const secrets: GeneratedSecretMaterial = {
      runtimeId: "job-backend",
      values: new Map([
        ["SESSION_SECRET", createOpaqueSecretValue(SECRET_MARKER)],
      ]),
    }
    const handle = await runtime.start(
      fakeWorkspace(bundleDir, "127.0.0.1"),
      { ...secretPlan, internalPort: port },
      secrets,
    )
    const serialized = await readFile(
      path.join(bundleDir, "config.json"),
      "utf8",
    )
    const config = JSON.parse(serialized)

    expect(serialized).not.toContain(SECRET_MARKER)
    expect(config.process.env).toEqual([
      "PORT=3000",
      "HOST=0.0.0.0",
      "NODE_ENV=production",
    ])
    expect(config.process.args).toEqual([
      "/usr/local/bin/node",
      "/opt/peephole/secret-bootstrap.mjs",
      "src/server.js",
    ])
    expect(config.process.args).not.toContain(SECRET_MARKER)
    // M11-C3 narrows the M10 mount from a directory bind onto `/run/secrets`
    // itself to an individual file bind onto the fixed `/run/secrets/env`
    // placeholder baked into the base rootfs -- see ociConfig.ts and
    // build-base-rootfs.sh. The sandbox-visible file/content is unchanged.
    const secretMounts = config.mounts.filter(
      (mount: { destination: string }) =>
        mount.destination === "/run/secrets/env",
    )
    expect(secretMounts).toEqual([
      {
        destination: "/run/secrets/env",
        type: "bind",
        source: path.join(secretRoot, "job-backend", "env"),
        options: ["bind", "ro", "nosuid", "nodev", "noexec"],
      },
    ])
    expect(
      config.mounts.filter(
        (mount: { destination: string }) =>
          mount.destination === "/run/secrets/database-url",
      ),
    ).toEqual([])

    await handle.stop()
    await expect(readdir(secretRoot)).resolves.toEqual([])
  })

  it("fails closed when a non-empty plan is started without secret material", async () => {
    const processRunner = new FakeProcessRunner()
    const runtime = new GVisorBackendRuntimeProcess({ processRunner })

    await expect(
      runtime.start(
        fakeWorkspace(bundleDir, "127.0.0.1"),
        { ...secretPlan, internalPort: port },
        null,
      ),
    ).rejects.toThrow(/does not match/)
    expect(processRunner.calls).toEqual([])
  })

  it("fails closed when secret material does not exactly match the plan names", async () => {
    const processRunner = new FakeProcessRunner()
    const runtime = new GVisorBackendRuntimeProcess({ processRunner })

    await expect(
      runtime.start(
        fakeWorkspace(bundleDir, "127.0.0.1"),
        { ...secretPlan, internalPort: port },
        {
          runtimeId: "job-backend",
          values: new Map([
            ["JWT_SECRET", createOpaqueSecretValue(SECRET_MARKER)],
          ]),
        },
      ),
    ).rejects.toThrow(/does not match/)
    expect(processRunner.calls).toEqual([])
  })

  it("fails closed when an empty plan receives secret material", async () => {
    const processRunner = new FakeProcessRunner()
    const runtime = new GVisorBackendRuntimeProcess({ processRunner })

    await expect(
      runtime.start(
        fakeWorkspace(bundleDir, "127.0.0.1"),
        { ...plan, internalPort: port },
        {
          runtimeId: "job-backend",
          values: new Map([
            ["SESSION_SECRET", createOpaqueSecretValue(SECRET_MARKER)],
          ]),
        },
      ),
    ).rejects.toThrow(/does not match/)
    expect(processRunner.calls).toEqual([])
  })

  it("cleans secret material when OCI bundle creation fails", async () => {
    const processRunner = new FakeProcessRunner()
    const generatedSecretFilesystem = new TmpfsGeneratedSecretFilesystem({
      rootDir: secretRoot,
      verifyMemoryBackedRoot: async () => undefined,
      setOwnership: async () => undefined,
    })
    const runtime = new GVisorBackendRuntimeProcess({
      processRunner,
      generatedSecretFilesystem,
    })
    const secrets: GeneratedSecretMaterial = {
      runtimeId: "job-backend",
      values: new Map([
        ["SESSION_SECRET", createOpaqueSecretValue(SECRET_MARKER)],
      ]),
    }

    await expect(
      runtime.start(
        fakeWorkspace(path.join(bundleDir, "missing"), "127.0.0.1"),
        { ...secretPlan, internalPort: port },
        secrets,
      ),
    ).rejects.toThrow()
    await expect(readdir(secretRoot)).resolves.toEqual([])
  })

  it("rejects mismatched runtime material without deleting another runtime's directory", async () => {
    const processRunner = new FakeProcessRunner()
    const generatedSecretFilesystem = new TmpfsGeneratedSecretFilesystem({
      rootDir: secretRoot,
      verifyMemoryBackedRoot: async () => undefined,
      setOwnership: async () => undefined,
    })
    const otherMaterial: GeneratedSecretMaterial = {
      runtimeId: "other-runtime",
      values: new Map([
        ["SESSION_SECRET", createOpaqueSecretValue(SECRET_MARKER)],
      ]),
    }
    await generatedSecretFilesystem.create(otherMaterial)
    const runtime = new GVisorBackendRuntimeProcess({
      processRunner,
      generatedSecretFilesystem,
    })

    await expect(
      runtime.start(
        fakeWorkspace(bundleDir, "127.0.0.1"),
        { ...secretPlan, internalPort: port },
        otherMaterial,
      ),
    ).rejects.toThrow(/does not match/)
    await expect(readdir(secretRoot)).resolves.toEqual(["other-runtime"])
  })

  it("does not log captured backend output containing a planted marker", async () => {
    const processRunner = new FakeProcessRunner()
    processRunner.crashResult = {
      exitCode: 1,
      timedOut: false,
      stdout: SECRET_MARKER,
      stderr: SECRET_MARKER,
    }
    const generatedSecretFilesystem = new TmpfsGeneratedSecretFilesystem({
      rootDir: secretRoot,
      verifyMemoryBackedRoot: async () => undefined,
      setOwnership: async () => undefined,
    })
    const runtime = new GVisorBackendRuntimeProcess({
      processRunner,
      generatedSecretFilesystem,
    })
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const handle = await runtime.start(
      fakeWorkspace(bundleDir, "127.0.0.1"),
      { ...secretPlan, internalPort: port },
      {
        runtimeId: "job-backend",
        values: new Map([
          ["SESSION_SECRET", createOpaqueSecretValue(SECRET_MARKER)],
        ]),
      },
    )

    await expect(handle.waitForExit()).resolves.toEqual({ exitCode: 1 })
    await expect(readdir(secretRoot)).resolves.toEqual([])
    expect(log).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    log.mockRestore()
    error.mockRestore()
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

  describe("temporary-database credential delivery (M11-C3)", () => {
    it("injects the database credential through one read-only mount and the trusted bootstrap, without serializing the URL", async () => {
      const processRunner = new FakeProcessRunner()
      const runtime = new GVisorBackendRuntimeProcess({
        processRunner,
        databaseCredentialFilesystem: databaseCredentialFilesystem(),
      })
      const credential = databaseCredential()
      const handle = await runtime.start(
        fakeWorkspace(bundleDir, "127.0.0.1"),
        { ...databasePlan, internalPort: port },
        null,
        credential,
      )
      const serialized = await readFile(
        path.join(bundleDir, "config.json"),
        "utf8",
      )
      const config = JSON.parse(serialized)

      expect(serialized).not.toContain(DATABASE_URL_MARKER)
      expect(config.process.env).toEqual([
        "PORT=3000",
        "HOST=0.0.0.0",
        "NODE_ENV=production",
      ])
      expect(config.process.args).toEqual([
        "/usr/local/bin/node",
        "/opt/peephole/secret-bootstrap.mjs",
        "src/server.js",
      ])
      expect(config.process.args).not.toContain(DATABASE_URL_MARKER)
      const databaseMounts = config.mounts.filter(
        (mount: { destination: string }) =>
          mount.destination === "/run/secrets/database-url",
      )
      expect(databaseMounts).toEqual([
        {
          destination: "/run/secrets/database-url",
          type: "bind",
          source: path.join(
            dbCredentialRoot,
            "job-backend",
            DATABASE_CREDENTIAL_FILE_NAME,
          ),
          options: ["bind", "ro", "nosuid", "nodev", "noexec"],
        },
      ])
      expect(
        config.mounts.filter(
          (mount: { destination: string }) =>
            mount.destination === "/run/secrets/env",
        ),
      ).toEqual([])

      await handle.stop()
      await expect(readdir(dbCredentialRoot)).resolves.toEqual([])
    })

    it("mounts both generated secrets and the database credential simultaneously, using the bootstrap exactly once", async () => {
      const processRunner = new FakeProcessRunner()
      const generatedSecretFilesystem = new TmpfsGeneratedSecretFilesystem({
        rootDir: secretRoot,
        verifyMemoryBackedRoot: async () => undefined,
        setOwnership: async () => undefined,
      })
      const runtime = new GVisorBackendRuntimeProcess({
        processRunner,
        generatedSecretFilesystem,
        databaseCredentialFilesystem: databaseCredentialFilesystem(),
      })
      const secrets: GeneratedSecretMaterial = {
        runtimeId: "job-backend",
        values: new Map([
          ["SESSION_SECRET", createOpaqueSecretValue(SECRET_MARKER)],
        ]),
      }
      const credential = databaseCredential()
      const handle = await runtime.start(
        fakeWorkspace(bundleDir, "127.0.0.1"),
        { ...databaseAndSecretPlan, internalPort: port },
        secrets,
        credential,
      )
      const config = JSON.parse(
        await readFile(path.join(bundleDir, "config.json"), "utf8"),
      )

      expect(config.process.args).toEqual([
        "/usr/local/bin/node",
        "/opt/peephole/secret-bootstrap.mjs",
        "src/server.js",
      ])
      expect(
        (config.process.args as string[]).filter(
          (value) => value === "/opt/peephole/secret-bootstrap.mjs",
        ),
      ).toHaveLength(1)
      expect(
        config.mounts.filter(
          (mount: { destination: string }) =>
            mount.destination === "/run/secrets/env",
        ),
      ).toEqual([
        {
          destination: "/run/secrets/env",
          type: "bind",
          source: path.join(secretRoot, "job-backend", "env"),
          options: ["bind", "ro", "nosuid", "nodev", "noexec"],
        },
      ])
      expect(
        config.mounts.filter(
          (mount: { destination: string }) =>
            mount.destination === "/run/secrets/database-url",
        ),
      ).toEqual([
        {
          destination: "/run/secrets/database-url",
          type: "bind",
          source: path.join(
            dbCredentialRoot,
            "job-backend",
            DATABASE_CREDENTIAL_FILE_NAME,
          ),
          options: ["bind", "ro", "nosuid", "nodev", "noexec"],
        },
      ])

      await handle.stop()
      await expect(readdir(secretRoot)).resolves.toEqual([])
      await expect(readdir(dbCredentialRoot)).resolves.toEqual([])
    })

    it("fails closed when database credential material is supplied for a non-database plan", async () => {
      const processRunner = new FakeProcessRunner()
      const runtime = new GVisorBackendRuntimeProcess({
        processRunner,
        databaseCredentialFilesystem: databaseCredentialFilesystem(),
      })

      await expect(
        runtime.start(
          fakeWorkspace(bundleDir, "127.0.0.1"),
          { ...plan, internalPort: port },
          null,
          databaseCredential(),
        ),
      ).rejects.toThrow(/does not match/)
      expect(processRunner.calls).toEqual([])
      await expect(readdir(dbCredentialRoot)).resolves.toEqual([])
    })

    it("fails closed when a database-requiring plan is started without database credential material", async () => {
      const processRunner = new FakeProcessRunner()
      const runtime = new GVisorBackendRuntimeProcess({
        processRunner,
        databaseCredentialFilesystem: databaseCredentialFilesystem(),
      })

      await expect(
        runtime.start(fakeWorkspace(bundleDir, "127.0.0.1"), {
          ...databasePlan,
          internalPort: port,
        }),
      ).rejects.toThrow(/does not match/)
      expect(processRunner.calls).toEqual([])
    })

    it("fails closed on a runtime-id mismatch between the workspace and the database credential", async () => {
      const processRunner = new FakeProcessRunner()
      const runtime = new GVisorBackendRuntimeProcess({
        processRunner,
        databaseCredentialFilesystem: databaseCredentialFilesystem(),
      })

      await expect(
        runtime.start(
          fakeWorkspace(bundleDir, "127.0.0.1"),
          { ...databasePlan, internalPort: port },
          null,
          databaseCredential("some-other-runtime"),
        ),
      ).rejects.toThrow(/does not match/)
      expect(processRunner.calls).toEqual([])
    })

    it("fails closed if the plan's database requirement name is ever anything other than DATABASE_URL", async () => {
      const runtime = new GVisorBackendRuntimeProcess({
        processRunner: new FakeProcessRunner(),
        databaseCredentialFilesystem: databaseCredentialFilesystem(),
      })
      const tamperedPlan: BackendRuntimePlan = {
        ...databasePlan,
        internalPort: port,
        databaseRequirement: { name: "POSTGRES_URL" } as unknown as {
          name: "DATABASE_URL"
        },
      }

      await expect(
        runtime.start(
          fakeWorkspace(bundleDir, "127.0.0.1"),
          tamperedPlan,
          null,
          databaseCredential(),
        ),
      ).rejects.toThrow(/does not match/)
    })

    it("fails closed when database credential material is supplied but no database credential filesystem is configured", async () => {
      const runtime = new GVisorBackendRuntimeProcess({
        processRunner: new FakeProcessRunner(),
      })

      await expect(
        runtime.start(
          fakeWorkspace(bundleDir, "127.0.0.1"),
          { ...databasePlan, internalPort: port },
          null,
          databaseCredential(),
        ),
      ).rejects.toThrow(/unavailable for this runtime/)
    })

    it("requests the database-capable ingress-only namespace only when database credential material is present", async () => {
      const processRunner = new FakeProcessRunner()
      const requests: Array<{ temporaryDatabaseAccess?: boolean } | undefined> =
        []
      const runtime = new GVisorBackendRuntimeProcess({
        processRunner,
        databaseCredentialFilesystem: databaseCredentialFilesystem(),
      })
      const workspace = fakeWorkspace(bundleDir, "127.0.0.1", {
        ensureIngressOnlyNetworkNamespace: async (options) => {
          requests.push(options)
          return { path: "/var/run/netns/fake-ingress", peerIp: "127.0.0.1" }
        },
      })

      const handle = await runtime.start(
        workspace,
        { ...databasePlan, internalPort: port },
        null,
        databaseCredential(),
      )
      await handle.stop()

      expect(requests).toEqual([{ temporaryDatabaseAccess: true }])
    })

    it("cleans the database credential file when network namespace acquisition fails after it was created", async () => {
      const processRunner = new FakeProcessRunner()
      const runtime = new GVisorBackendRuntimeProcess({
        processRunner,
        databaseCredentialFilesystem: databaseCredentialFilesystem(),
      })
      const workspace = fakeWorkspace(bundleDir, "127.0.0.1", {
        ensureIngressOnlyNetworkNamespace: async () => {
          throw new Error("simulated network namespace failure")
        },
      })

      await expect(
        runtime.start(
          workspace,
          { ...databasePlan, internalPort: port },
          null,
          databaseCredential(),
        ),
      ).rejects.toThrow()
      await expect(readdir(dbCredentialRoot)).resolves.toEqual([])
    })

    it("cleans the database credential file when OCI bundle construction/write fails", async () => {
      const processRunner = new FakeProcessRunner()
      const runtime = new GVisorBackendRuntimeProcess({
        processRunner,
        databaseCredentialFilesystem: databaseCredentialFilesystem(),
      })

      await expect(
        runtime.start(
          fakeWorkspace(path.join(bundleDir, "missing"), "127.0.0.1"),
          { ...databasePlan, internalPort: port },
          null,
          databaseCredential(),
        ),
      ).rejects.toThrow()
      await expect(readdir(dbCredentialRoot)).resolves.toEqual([])
    })

    it("cleans the database credential file after a runsc start/container failure surfaces through waitForExit", async () => {
      const processRunner = new FakeProcessRunner()
      processRunner.crashResult = {
        exitCode: 1,
        timedOut: false,
        stdout: "",
        stderr: "",
      }
      const runtime = new GVisorBackendRuntimeProcess({
        processRunner,
        databaseCredentialFilesystem: databaseCredentialFilesystem(),
      })
      const handle = await runtime.start(
        fakeWorkspace(bundleDir, "127.0.0.1"),
        { ...databasePlan, internalPort: port },
        null,
        databaseCredential(),
      )

      await expect(handle.waitForExit()).resolves.toEqual({ exitCode: 1 })
      await expect(readdir(dbCredentialRoot)).resolves.toEqual([])
    })

    it("removes the database credential file on stop()", async () => {
      const processRunner = new FakeProcessRunner()
      const runtime = new GVisorBackendRuntimeProcess({
        processRunner,
        databaseCredentialFilesystem: databaseCredentialFilesystem(),
      })
      const handle = await runtime.start(
        fakeWorkspace(bundleDir, "127.0.0.1"),
        { ...databasePlan, internalPort: port },
        null,
        databaseCredential(),
      )
      await expect(readdir(dbCredentialRoot)).resolves.toEqual(["job-backend"])

      await handle.stop()

      await expect(readdir(dbCredentialRoot)).resolves.toEqual([])
    })

    it("combines independent generated-secret and database-credential cleanup failures into one AggregateError", async () => {
      const processRunner = new FakeProcessRunner()
      const realSecretFs = new TmpfsGeneratedSecretFilesystem({
        rootDir: secretRoot,
        verifyMemoryBackedRoot: async () => undefined,
        setOwnership: async () => undefined,
      })
      const realDbFs = databaseCredentialFilesystem()
      const failingSecretFs = {
        rootDir: realSecretFs.rootDir,
        create: (m: GeneratedSecretMaterial) => realSecretFs.create(m),
        remove: async () => {
          throw new Error("simulated secret cleanup failure")
        },
      }
      const failingDbFs = {
        rootDir: realDbFs.rootDir,
        create: (m: TemporaryDatabaseRuntimeCredentialMaterial) =>
          realDbFs.create(m),
        remove: async () => {
          throw new Error("simulated database credential cleanup failure")
        },
      }
      const runtime = new GVisorBackendRuntimeProcess({
        processRunner,
        generatedSecretFilesystem: failingSecretFs,
        databaseCredentialFilesystem: failingDbFs,
      })
      const secrets: GeneratedSecretMaterial = {
        runtimeId: "job-backend",
        values: new Map([
          ["SESSION_SECRET", createOpaqueSecretValue(SECRET_MARKER)],
        ]),
      }
      const workspace = fakeWorkspace(bundleDir, "127.0.0.1", {
        ensureIngressOnlyNetworkNamespace: async () => {
          throw new Error("simulated network namespace failure")
        },
      })

      const error: unknown = await runtime
        .start(
          workspace,
          { ...databaseAndSecretPlan, internalPort: port },
          secrets,
          databaseCredential(),
        )
        .catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(AggregateError)
      const outer = error as AggregateError
      expect(outer.errors).toHaveLength(2)
      // outer.errors[0] is the original namespace failure; [1] is whatever
      // cleanupCredentials() threw -- itself an AggregateError combining the
      // two independent, always-both-attempted credential cleanup failures.
      expect(outer.errors[1]).toBeInstanceOf(AggregateError)
      expect((outer.errors[1] as AggregateError).errors).toHaveLength(2)
    })
  })
})
