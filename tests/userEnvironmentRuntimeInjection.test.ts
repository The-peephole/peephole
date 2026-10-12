import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import { createServer, type Server } from "node:net"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createOpaqueSecretValue } from "../core/backendSecrets/generatedSecretValue"
import {
  TENANT_DATABASE_HOST,
  TENANT_DATABASE_PORT,
} from "../core/backendDatabase/databaseUrl"
import {
  deriveTemporaryDatabaseObjectName,
  mintTemporaryDatabaseResourceId,
} from "../core/backendDatabase/resourceIdentity"
import {
  TmpfsDatabaseCredentialFilesystem,
  serializeDatabaseCredentialMaterial,
} from "../services/preview-worker/gvisor/databaseCredentialFilesystem"
import { serializeGeneratedSecretMaterial } from "../services/preview-worker/gvisor/generatedSecretFilesystem"
import {
  parseUserEnvironmentMaterial,
  runSecretBootstrap,
} from "../scripts/gvisor/secret-bootstrap.mjs"
import { GVisorBackendRuntimeProcess } from "../services/preview-worker/gvisor/backendRuntimeProcess"
import { TmpfsGeneratedSecretFilesystem } from "../services/preview-worker/gvisor/generatedSecretFilesystem"
import type { GVisorPreviewWorkspace } from "../services/preview-worker/gvisor/gvisorWorkspace"
import type {
  ProcessRunner,
  ProcessRunResult,
} from "../services/preview-worker/gvisor/processRunner"
import { SANDBOX_USER_ENVIRONMENT_BOOTSTRAP_FLAG } from "../services/preview-worker/gvisor/sandboxIdentity"
import {
  SANDBOX_USER_ENVIRONMENT_FILE,
  TmpfsUserEnvironmentFilesystem,
  USER_ENVIRONMENT_FILE_NAME,
  serializeUserEnvironmentMaterial,
} from "../services/preview-worker/gvisor/userEnvironmentFilesystem"
import { UserEnvironmentOrphanReaper } from "../services/preview-worker/gvisor/userEnvironmentOrphanReaper"
import type { BackendRuntimePlan } from "../types/backendRuntime"
import type { UserEnvironmentMaterial } from "../types/userEnvironment"

const SENTINEL = "PEEPHOLE_E2E_SYNTHETIC_VALUE_2026"
const RUNTIME_ID = "job-backend"
const char = (code: number) => String.fromCharCode(code)

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
  userEnvironmentNames: ["APP_GREETING", "FEATURE_MODE"],
}

function material(
  values: Record<string, string> = {
    APP_GREETING: SENTINEL,
    FEATURE_MODE: "demo",
  },
  runtimeId = RUNTIME_ID,
): UserEnvironmentMaterial {
  return {
    runtimeId,
    values: new Map(
      Object.entries(values).map(([name, value]) => [
        name,
        createOpaqueSecretValue(value),
      ]),
    ),
  }
}

class FakeProcessRunner implements ProcessRunner {
  readonly calls: Array<{ command: string; args: string[] }> = []
  private runResolve: ((result: ProcessRunResult) => void) | null = null
  crashResult: ProcessRunResult | null = null

  async run(command: string, args: string[]): Promise<ProcessRunResult> {
    this.calls.push({ command, args })
    const ok = { exitCode: 0, timedOut: false, stdout: "", stderr: "" }
    if (args.includes("kill")) {
      this.runResolve?.({ ...ok, exitCode: 137 })
      this.runResolve = null
      return ok
    }
    if (args.includes("run")) {
      if (this.crashResult) return this.crashResult
      return new Promise((resolve) => {
        this.runResolve = resolve
      })
    }
    return ok
  }
}

function fakeWorkspace(bundleDir: string): GVisorPreviewWorkspace {
  const containers = new Set<string>()
  return {
    id: RUNTIME_ID,
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
      peerIp: "127.0.0.1",
    }),
  }
}

describe("M12 runtime injection", () => {
  let server: Server
  let port: number
  let bundleDir: string
  let userRoot: string
  let secretRoot: string
  const modes: Array<[string, number]> = []

  beforeEach(async () => {
    server = createServer((socket) => socket.end())
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    port = (server.address() as { port: number }).port
    bundleDir = await mkdtemp(path.join(os.tmpdir(), "peephole-m12-bundle-"))
    userRoot = await mkdtemp(path.join(os.tmpdir(), "peephole-m12-user-env-"))
    secretRoot = await mkdtemp(path.join(os.tmpdir(), "peephole-m12-secrets-"))
    modes.length = 0
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    for (const dir of [bundleDir, userRoot, secretRoot]) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  function userFilesystem(rootDir = userRoot) {
    return new TmpfsUserEnvironmentFilesystem({
      rootDir,
      verifyMemoryBackedRoot: async () => undefined,
      setOwnership: async () => undefined,
      setMode: async (candidate, mode) => {
        modes.push([path.relative(rootDir, candidate), mode])
      },
    })
  }

  describe("GVisorBackendRuntimeProcess", () => {
    it("delivers values only through the tmpfs mount, never config.json, env, or argv", async () => {
      const processRunner = new FakeProcessRunner()
      const runtime = new GVisorBackendRuntimeProcess({
        processRunner,
        userEnvironmentFilesystem: userFilesystem(),
      })
      const handle = await runtime.start(
        fakeWorkspace(bundleDir),
        { ...plan, internalPort: port },
        null,
        null,
        material(),
      )

      const serialized = await readFile(
        path.join(bundleDir, "config.json"),
        "utf8",
      )
      const config = JSON.parse(serialized)
      expect(serialized).not.toContain(SENTINEL)
      expect(serialized).not.toContain("demo")
      expect(config.process.env).toEqual([
        "PORT=3000",
        "HOST=0.0.0.0",
        "NODE_ENV=production",
      ])
      expect(config.process.args).toEqual([
        "/usr/local/bin/node",
        "/opt/peephole/secret-bootstrap.mjs",
        SANDBOX_USER_ENVIRONMENT_BOOTSTRAP_FLAG,
        "src/server.js",
      ])
      const environmentFile = path.join(
        userRoot,
        RUNTIME_ID,
        USER_ENVIRONMENT_FILE_NAME,
      )
      expect(
        config.mounts.filter((mount: { destination: string }) =>
          mount.destination.startsWith("/run/secrets"),
        ),
      ).toEqual([
        {
          destination: SANDBOX_USER_ENVIRONMENT_FILE,
          type: "bind",
          source: environmentFile,
          options: ["bind", "ro", "nosuid", "nodev", "noexec"],
        },
      ])
      // The file exists only while the runtime runs, with restrictive modes.
      expect(JSON.parse(await readFile(environmentFile, "utf8"))).toEqual({
        APP_GREETING: SENTINEL,
        FEATURE_MODE: "demo",
      })
      expect(modes).toEqual([
        ["", 0o700],
        [RUNTIME_ID, 0o700],
        [path.join(RUNTIME_ID, USER_ENVIRONMENT_FILE_NAME), 0o600],
      ])
      for (const call of processRunner.calls) {
        expect(call.args.join(" ")).not.toContain(SENTINEL)
      }

      await handle.stop()
      await expect(readdir(userRoot)).resolves.toEqual([])
      // Duplicate cleanup is harmless.
      await expect(handle.stop()).resolves.toBeUndefined()
    })

    it("mounts generated secrets and user configuration as independent siblings with one bootstrap", async () => {
      const runtime = new GVisorBackendRuntimeProcess({
        processRunner: new FakeProcessRunner(),
        userEnvironmentFilesystem: userFilesystem(),
        generatedSecretFilesystem: new TmpfsGeneratedSecretFilesystem({
          rootDir: secretRoot,
          verifyMemoryBackedRoot: async () => undefined,
          setOwnership: async () => undefined,
        }),
      })
      const handle = await runtime.start(
        fakeWorkspace(bundleDir),
        {
          ...plan,
          internalPort: port,
          generatedSecretNames: ["SESSION_SECRET"],
        },
        {
          runtimeId: RUNTIME_ID,
          values: new Map([
            ["SESSION_SECRET", createOpaqueSecretValue("M10Marker_abc")],
          ]),
        },
        null,
        material(),
      )
      const config = JSON.parse(
        await readFile(path.join(bundleDir, "config.json"), "utf8"),
      )
      expect(
        config.process.args.filter(
          (arg: string) => arg === "/opt/peephole/secret-bootstrap.mjs",
        ),
      ).toHaveLength(1)
      expect(
        config.mounts
          .map((mount: { destination: string }) => mount.destination)
          .filter((destination: string) =>
            destination.startsWith("/run/secrets"),
          ),
      ).toEqual(["/run/secrets/env", SANDBOX_USER_ENVIRONMENT_FILE])
      await handle.stop()
      await expect(readdir(userRoot)).resolves.toEqual([])
      await expect(readdir(secretRoot)).resolves.toEqual([])
    })

    it("cleans up the file when the process exits on its own", async () => {
      const processRunner = new FakeProcessRunner()
      processRunner.crashResult = {
        exitCode: 1,
        timedOut: false,
        stdout: SENTINEL,
        stderr: SENTINEL,
      }
      const runtime = new GVisorBackendRuntimeProcess({
        processRunner,
        userEnvironmentFilesystem: userFilesystem(),
      })
      const handle = await runtime.start(
        fakeWorkspace(bundleDir),
        { ...plan, internalPort: port },
        null,
        null,
        material(),
      )
      await expect(handle.waitForExit()).resolves.toEqual({ exitCode: 1 })
      await expect(readdir(userRoot)).resolves.toEqual([])
    })

    it.each([
      ["missing material", null],
      ["material for another runtime", material(undefined, "job-other")],
      ["material missing a name", material({ APP_GREETING: SENTINEL })],
      [
        "material with an extra name",
        material({ APP_GREETING: "a", FEATURE_MODE: "b", OTHER_MODE: "c" }),
      ],
    ])(
      "refuses to start with %s, before anything is written",
      async (_label, candidate) => {
        const processRunner = new FakeProcessRunner()
        const runtime = new GVisorBackendRuntimeProcess({
          processRunner,
          userEnvironmentFilesystem: userFilesystem(),
        })
        await expect(
          runtime.start(fakeWorkspace(bundleDir), plan, null, null, candidate),
        ).rejects.toThrow("User environment material does not match")
        await expect(readdir(userRoot)).resolves.toEqual([])
        expect(processRunner.calls).toEqual([])
      },
    )

    it("refuses material for a plan that names no configuration", async () => {
      const runtime = new GVisorBackendRuntimeProcess({
        processRunner: new FakeProcessRunner(),
        userEnvironmentFilesystem: userFilesystem(),
      })
      await expect(
        runtime.start(
          fakeWorkspace(bundleDir),
          { ...plan, userEnvironmentNames: [] },
          null,
          null,
          material(),
        ),
      ).rejects.toThrow("User environment material does not match")
    })

    it("fails closed without a filesystem, leaving nothing behind", async () => {
      const runtime = new GVisorBackendRuntimeProcess({
        processRunner: new FakeProcessRunner(),
      })
      await expect(
        runtime.start(fakeWorkspace(bundleDir), plan, null, null, material()),
      ).rejects.toThrow("User environment filesystem is unavailable")
      await expect(readdir(bundleDir)).resolves.toEqual([])
    })

    it("refuses a user-env root inside persistent bundle storage", async () => {
      const runtime = new GVisorBackendRuntimeProcess({
        processRunner: new FakeProcessRunner(),
        userEnvironmentFilesystem: userFilesystem(path.join(bundleDir, "env")),
      })
      await expect(
        runtime.start(fakeWorkspace(bundleDir), plan, null, null, material()),
      ).rejects.toThrow("overlaps persistent runtime storage")
    })

    it("refuses overlapping user-env and credential roots at construction", () => {
      expect(
        () =>
          new GVisorBackendRuntimeProcess({
            userEnvironmentFilesystem: userFilesystem(secretRoot),
            generatedSecretFilesystem: new TmpfsGeneratedSecretFilesystem({
              rootDir: secretRoot,
            }),
          }),
      ).toThrow("must be disjoint")
    })
  })

  describe("TmpfsUserEnvironmentFilesystem", () => {
    it("serializes one sorted JSON object and a trailing newline", () => {
      expect(
        serializeUserEnvironmentMaterial(
          material({ FEATURE_MODE: "a=b c", APP_GREETING: '안녕 "q" \\' }),
        ),
      ).toBe(`{"APP_GREETING":"안녕 \\"q\\" \\\\","FEATURE_MODE":"a=b c"}\n`)
    })

    it.each([
      ["no entries", material({})],
      ["a reserved name", material({ NODE_OPTIONS: "--require=/x" })],
      ["a generated-secret name", material({ SESSION_SECRET: "x" })],
      ["DATABASE_URL", material({ DATABASE_URL: "postgres://x" })],
      ["a newline", material({ APP_GREETING: `${SENTINEL}${char(10)}X=1` })],
      ["a NUL", material({ APP_GREETING: `${SENTINEL}${char(0)}` })],
      ["an oversized value", material({ APP_GREETING: "x".repeat(1_025) })],
      ["an invalid runtime id", material(undefined, "../escape")],
    ])("refuses %s without writing or echoing", async (_label, candidate) => {
      const filesystem = userFilesystem()
      const error = await filesystem.create(candidate).catch((e: Error) => e)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).not.toContain(SENTINEL)
      await expect(readdir(userRoot)).resolves.toEqual([])
    })

    it("refuses to overwrite an existing runtime directory", async () => {
      const filesystem = userFilesystem()
      await filesystem.create(material())
      await expect(filesystem.create(material())).rejects.toThrow(
        "User environment filesystem operation failed",
      )
      await filesystem.remove(RUNTIME_ID)
      await filesystem.remove(RUNTIME_ID)
      await expect(readdir(userRoot)).resolves.toEqual([])
    })

    it("refuses a symlinked root", async () => {
      const link = path.join(bundleDir, "linked-root")
      try {
        await symlink(userRoot, link, "junction")
      } catch {
        return // Symlinks unavailable on this host.
      }
      await expect(userFilesystem(link).create(material())).rejects.toThrow()
    })

    it("fails closed when the root is not memory-backed", async () => {
      const filesystem = new TmpfsUserEnvironmentFilesystem({
        rootDir: userRoot,
        verifyMemoryBackedRoot: async () => {
          throw new Error("not tmpfs")
        },
        setOwnership: async () => undefined,
      })
      await expect(filesystem.create(material())).rejects.toThrow()
      await expect(readdir(userRoot)).resolves.toEqual([])
    })

    it.each([
      "/var/lib/peephole/jobs/x",
      "/run/peephole/secrets",
      "/run/peephole/db-credentials/nested",
    ])("refuses the forbidden root %s", (rootDir) => {
      expect(() => new TmpfsUserEnvironmentFilesystem({ rootDir })).toThrow(
        "must be separate",
      )
    })
  })

  describe("UserEnvironmentOrphanReaper", () => {
    it("removes every owned entry at startup and only stale ones periodically", async () => {
      const filesystem = userFilesystem()
      await filesystem.create(material(undefined, "runtime-fresh"))
      await filesystem.create(material(undefined, "runtime-stale"))
      await mkdir(path.join(userRoot, "not a runtime id"))
      const old = new Date(Date.now() - 60 * 60_000)
      await utimes(path.join(userRoot, "runtime-stale"), old, old)
      const reaper = new UserEnvironmentOrphanReaper({
        rootDir: userRoot,
        filesystem,
        verifyMemoryBackedRoot: async () => undefined,
        maxAgeMs: 30 * 60_000,
      })

      await expect(reaper.reap()).resolves.toEqual(["runtime-stale"])
      await expect(reaper.reapAll()).resolves.toEqual(["runtime-fresh"])
      // Unrelated entries are never touched.
      await expect(readdir(userRoot)).resolves.toEqual(["not a runtime id"])
    })

    it("is a no-op when the root does not exist", async () => {
      const missing = path.join(userRoot, "missing")
      const reaper = new UserEnvironmentOrphanReaper({
        rootDir: missing,
        filesystem: userFilesystem(missing),
        verifyMemoryBackedRoot: async () => {
          throw new Error("must not be called")
        },
      })
      await expect(reaper.reapAll()).resolves.toEqual([])
    })
  })
})

class FakeChild extends EventEmitter {
  killed = false
  readonly kill = vi.fn(() => {
    this.killed = true
    return true
  })
}

describe("trusted bootstrap user environment delivery", () => {
  let dir: string
  let userFile: string
  let emptyPlaceholder: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "peephole-m12-bootstrap-"))
    userFile = path.join(dir, "user-env")
    emptyPlaceholder = path.join(dir, "empty")
    await writeFile(emptyPlaceholder, "")
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function run(options: {
    userEnvironmentFile: string
    childArgs: string[]
    baseEnvironment?: NodeJS.ProcessEnv
  }) {
    const child = new FakeChild()
    const spawned: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = []
    const result = runSecretBootstrap({
      secretFile: emptyPlaceholder,
      databaseCredentialFile: emptyPlaceholder,
      userEnvironmentFile: options.userEnvironmentFile,
      nodeBinary: process.execPath,
      childArgs: options.childArgs,
      baseEnvironment: options.baseEnvironment ?? { PORT: "3000" },
      spawnChild: (_command, args, spawnOptions) => {
        spawned.push({ args, env: spawnOptions.env })
        queueMicrotask(() => child.emit("close", 0, null))
        return child as unknown as ChildProcess
      },
    })
    return { result, spawned }
  }

  it("passes the values to the child environment only, stripping the flag", async () => {
    await writeFile(userFile, serializeUserEnvironmentMaterial(material()))
    const { result, spawned } = run({
      userEnvironmentFile: userFile,
      childArgs: [SANDBOX_USER_ENVIRONMENT_BOOTSTRAP_FLAG, "server.js"],
    })
    await expect(result).resolves.toEqual({ exitCode: 0, signal: null })
    expect(spawned).toEqual([
      {
        args: ["server.js"],
        env: { PORT: "3000", APP_GREETING: SENTINEL, FEATURE_MODE: "demo" },
      },
    ])
  })

  it("fails closed when flagged but nothing is mounted (stale or missing material)", async () => {
    for (const file of [emptyPlaceholder, path.join(dir, "missing")]) {
      const { result, spawned } = run({
        userEnvironmentFile: file,
        childArgs: [SANDBOX_USER_ENVIRONMENT_BOOTSTRAP_FLAG, "server.js"],
      })
      await expect(result).rejects.toThrow(
        "Malformed user environment material.",
      )
      expect(spawned).toEqual([])
    }
  })

  it("fails closed when material is mounted without the flag", async () => {
    await writeFile(userFile, serializeUserEnvironmentMaterial(material()))
    const { result, spawned } = run({
      userEnvironmentFile: userFile,
      childArgs: ["server.js"],
    })
    await expect(result).rejects.toThrow("Malformed user environment material.")
    expect(spawned).toEqual([])
  })

  it("refuses a value that would override the platform environment", async () => {
    await writeFile(userFile, `{"APP_GREETING":"x"}\n`)
    const { result } = run({
      userEnvironmentFile: userFile,
      childArgs: [SANDBOX_USER_ENVIRONMENT_BOOTSTRAP_FLAG, "server.js"],
      baseEnvironment: { PORT: "3000", APP_GREETING: "platform" },
    })
    await expect(result).rejects.toThrow("Malformed user environment material.")
  })

  it("leaves existing runs without the flag unchanged", async () => {
    const { result, spawned } = run({
      userEnvironmentFile: path.join(dir, "missing"),
      childArgs: ["server.js"],
    })
    await expect(result).resolves.toEqual({ exitCode: 0, signal: null })
    expect(spawned[0]?.env).toEqual({ PORT: "3000" })
  })

  it.each([
    ["no trailing newline", `{"APP_GREETING":"x"}`],
    ["two trailing lines", `{"APP_GREETING":"x"}\n\n`],
    ["leading whitespace", ` {"APP_GREETING":"x"}\n`],
    ["a multi-line object", `{\n"APP_GREETING":"x"}\n`],
    ["CRLF framing", `{"APP_GREETING":"x"}\r\n`],
    ["not JSON", "APP_GREETING=x\n"],
    ["an array", `[["APP_GREETING","x"]]\n`],
    ["an empty object", "{}\n"],
    ["an empty value", `{"APP_GREETING":""}\n`],
    ["a non-string value", `{"APP_GREETING":1}\n`],
    ["a lowercase name", `{"app_greeting":"x"}\n`],
    ["a __proto__ key", `{"__proto__":"x"}\n`],
    ["NODE_OPTIONS", `{"NODE_OPTIONS":"--require=/workspace/x.js"}\n`],
    ["LD_PRELOAD", `{"LD_PRELOAD":"/workspace/x.so"}\n`],
    ["PATH", `{"PATH":"/workspace"}\n`],
    ["PORT", `{"PORT":"1"}\n`],
    ["DATABASE_URL", `{"DATABASE_URL":"postgresql://x"}\n`],
    ["SESSION_SECRET", `{"SESSION_SECRET":"x"}\n`],
    ["NPM_CONFIG_*", `{"NPM_CONFIG_SCRIPT_SHELL":"/bin/sh"}\n`],
    ["PEEPHOLE_*", `{"PEEPHOLE_X":"x"}\n`],
    ["VITE_*", `{"VITE_X":"x"}\n`],
    ["an escaped newline", `{"APP_GREETING":"a\\nb"}\n`],
    ["an escaped NUL", `{"APP_GREETING":"a\\u0000b"}\n`],
    ["an escaped lone surrogate", `{"APP_GREETING":"\\ud800"}\n`],
    ["an escaped line separator", `{"APP_GREETING":"\\u2028"}\n`],
    ["an oversized value", `{"APP_GREETING":"${"x".repeat(1_025)}"}\n`],
    [
      "too many entries",
      `${JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 17 }, (_, index) => [
            `SETTING_${String(index)}`,
            "x",
          ]),
        ),
      )}\n`,
    ],
  ])("rejects %s", (_label, contents) => {
    expect(() => parseUserEnvironmentMaterial(contents)).toThrow(
      "Malformed user environment material.",
    )
  })

  it("accepts an astral character and metacharacters as plain data", () => {
    expect(
      parseUserEnvironmentMaterial(`{"APP_GREETING":"👋 $(id) \`x\` ; a=b"}\n`),
    ).toEqual({ APP_GREETING: "👋 $(id) `x` ; a=b" })
  })
})

describe("G: independent M10 / M11 / M12 runtime material", () => {
  const DATABASE_RESOURCE_ID = mintTemporaryDatabaseResourceId(() =>
    new Uint8Array(14).fill(7),
  )
  const DATABASE_OBJECT_NAME =
    deriveTemporaryDatabaseObjectName(DATABASE_RESOURCE_ID)
  const DATABASE_URL = `postgresql://${DATABASE_OBJECT_NAME}:M11Marker_9Kp2-Z@${TENANT_DATABASE_HOST}:${String(TENANT_DATABASE_PORT)}/${DATABASE_OBJECT_NAME}`
  const M10_MARKER = "M10Marker_4Rt8-W"

  let server: Server
  let port: number
  let bundleDir: string
  const roots: Record<"user" | "secret" | "db", string> = {
    user: "",
    secret: "",
    db: "",
  }

  beforeEach(async () => {
    server = createServer((socket) => socket.end())
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    port = (server.address() as { port: number }).port
    bundleDir = await mkdtemp(path.join(os.tmpdir(), "peephole-m12g-bundle-"))
    for (const key of Object.keys(roots) as Array<keyof typeof roots>) {
      roots[key] = await mkdtemp(
        path.join(os.tmpdir(), `peephole-m12g-${key}-`),
      )
    }
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    for (const dir of [bundleDir, ...Object.values(roots)]) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  const seams = {
    verifyMemoryBackedRoot: async () => undefined,
    setOwnership: async () => undefined,
  }

  function runtime() {
    return new GVisorBackendRuntimeProcess({
      processRunner: new FakeProcessRunner(),
      userEnvironmentFilesystem: new TmpfsUserEnvironmentFilesystem({
        rootDir: roots.user,
        ...seams,
      }),
      generatedSecretFilesystem: new TmpfsGeneratedSecretFilesystem({
        rootDir: roots.secret,
        ...seams,
      }),
      databaseCredentialFilesystem: new TmpfsDatabaseCredentialFilesystem({
        rootDir: roots.db,
        ...seams,
      }),
    })
  }

  const secrets = () => ({
    runtimeId: RUNTIME_ID,
    values: new Map([
      ["SESSION_SECRET" as const, createOpaqueSecretValue(M10_MARKER)],
    ]),
  })
  const database = () => ({
    runtimeId: RUNTIME_ID,
    resourceId: DATABASE_RESOURCE_ID,
    databaseUrl: createOpaqueSecretValue(DATABASE_URL),
  })

  it.each([
    ["none", { m10: false, m11: false, m12: false }],
    ["M10 only", { m10: true, m11: false, m12: false }],
    ["M11 only", { m10: false, m11: true, m12: false }],
    ["M12 only", { m10: false, m11: false, m12: true }],
    ["M10 + M11", { m10: true, m11: true, m12: false }],
    ["M10 + M12", { m10: true, m11: false, m12: true }],
    ["M11 + M12", { m10: false, m11: true, m12: true }],
    ["M10 + M11 + M12", { m10: true, m11: true, m12: true }],
  ])(
    "%s: exactly the matching mounts, no values in config.json, full cleanup",
    async (_label, use) => {
      const handle = await runtime().start(
        fakeWorkspace(bundleDir),
        {
          ...plan,
          internalPort: port,
          generatedSecretNames: use.m10 ? ["SESSION_SECRET"] : [],
          databaseRequirement: use.m11 ? { name: "DATABASE_URL" } : null,
          userEnvironmentNames: use.m12 ? plan.userEnvironmentNames : [],
        },
        use.m10 ? secrets() : null,
        use.m11 ? database() : null,
        use.m12 ? material() : null,
      )
      const serialized = await readFile(
        path.join(bundleDir, "config.json"),
        "utf8",
      )
      const config = JSON.parse(serialized)
      for (const marker of [M10_MARKER, DATABASE_URL, "M11Marker", SENTINEL]) {
        expect(serialized).not.toContain(marker)
      }
      expect(config.process.env).toEqual([
        "PORT=3000",
        "HOST=0.0.0.0",
        "NODE_ENV=production",
      ])
      const expectedMounts = [
        ...(use.m10 ? ["/run/secrets/env"] : []),
        ...(use.m11 ? ["/run/secrets/database-url"] : []),
        ...(use.m12 ? ["/run/secrets/user-env"] : []),
      ]
      expect(
        config.mounts
          .map((mount: { destination: string }) => mount.destination)
          .filter((destination: string) =>
            destination.startsWith("/run/secrets"),
          ),
      ).toEqual(expectedMounts)
      const usesBootstrap = use.m10 || use.m11 || use.m12
      expect(config.process.args).toEqual([
        "/usr/local/bin/node",
        ...(usesBootstrap ? ["/opt/peephole/secret-bootstrap.mjs"] : []),
        ...(use.m12 ? [SANDBOX_USER_ENVIRONMENT_BOOTSTRAP_FLAG] : []),
        "src/server.js",
      ])
      await handle.stop()
      for (const root of Object.values(roots)) {
        await expect(readdir(root)).resolves.toEqual([])
      }
    },
  )

  it("bootstrap delivers all three files to one child environment, independently parsed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "peephole-m12g-boot-"))
    try {
      const files = {
        secretFile: path.join(dir, "env"),
        databaseCredentialFile: path.join(dir, "database-url"),
        userEnvironmentFile: path.join(dir, "user-env"),
      }
      await writeFile(
        files.secretFile,
        serializeGeneratedSecretMaterial(secrets()),
      )
      await writeFile(
        files.databaseCredentialFile,
        serializeDatabaseCredentialMaterial(database()),
      )
      await writeFile(
        files.userEnvironmentFile,
        serializeUserEnvironmentMaterial(material()),
      )
      const child = new FakeChild()
      let env: NodeJS.ProcessEnv | undefined
      let args: string[] | undefined
      await runSecretBootstrap({
        ...files,
        nodeBinary: process.execPath,
        childArgs: [SANDBOX_USER_ENVIRONMENT_BOOTSTRAP_FLAG, "server.js"],
        baseEnvironment: {
          PORT: "3000",
          HOST: "0.0.0.0",
          NODE_ENV: "production",
        },
        spawnChild: (_command, childArgs, options) => {
          env = options.env
          args = childArgs
          queueMicrotask(() => child.emit("close", 0, null))
          return child as unknown as ChildProcess
        },
      })
      expect(args).toEqual(["server.js"])
      expect(env).toEqual({
        PORT: "3000",
        HOST: "0.0.0.0",
        NODE_ENV: "production",
        SESSION_SECRET: M10_MARKER,
        DATABASE_URL,
        APP_GREETING: SENTINEL,
        FEATURE_MODE: "demo",
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
