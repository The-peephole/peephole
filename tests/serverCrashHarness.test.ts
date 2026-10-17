import path from "node:path"
import { describe, expect, it, vi } from "vitest"

import { readGitHubAppOAuthConfig } from "../services/preview-api/githubAppOAuthConfig"
import { readPreviewApiServerConfig } from "../services/preview-api/serverConfig"
import { readProductionConfig } from "../services/production/config"
import { InMemoryUserEnvironmentBroker } from "../services/user-environment/userEnvironmentBroker"
import {
  assertDedicatedTestDatabaseUrl,
  assertRootsWithin,
  B2_REAL_GATE,
  buildServerEnvironment,
  classifyBoundary,
  classifyExit,
  classifyH1,
  classifyH2,
  crashOwnedServer,
  formatB2Evidence,
  freezeOwnedServer,
  inspectOwnedServer,
  linuxProcessInspection,
  OWNED_RESOURCE_KINDS,
  parseB2Fixture,
  realServerCrashEnabled,
  reverifyOwnedServer,
  SERVER_NONCE_VARIABLE,
  spawnOwnedServer,
  syntheticEnvironment,
  syntheticServerSecrets,
  thawOwnedServer,
  type ExpectedServer,
  type H1Facts,
  type H2Facts,
  type OwnedServer,
  type ProcessInspection,
  type ServerRoots,
} from "./support/serverCrashHarness"

const allGates = {
  [B2_REAL_GATE]: "1",
  PEEPHOLE_REAL_GVISOR_TESTS: "1",
  PEEPHOLE_M12_REAL_GVISOR_TESTS: "1",
}

describe("B2 real-crash gate", () => {
  it("is disabled unless all three gates are exactly 1 on Linux", () => {
    expect(realServerCrashEnabled({}, "linux")).toBe(false)
    expect(realServerCrashEnabled(allGates, "linux")).toBe(true)
    expect(realServerCrashEnabled(allGates, "win32")).toBe(false)
    expect(realServerCrashEnabled(allGates, "darwin")).toBe(false)
    for (const gate of Object.keys(allGates))
      for (const value of ["0", "", " 1", "true", "yes"])
        expect(
          realServerCrashEnabled({ ...allGates, [gate]: value }, "linux"),
        ).toBe(false)
  })

  it.skipIf(realServerCrashEnabled(process.env))(
    "is disabled in this Portable run, so the real crash suite is skipped",
    () => {
      expect(realServerCrashEnabled(process.env)).toBe(false)
    },
  )
})

const entry = "/repo/services/production/server.ts"
const expected: ExpectedServer = {
  harnessPid: 4000,
  executable: "/usr/bin/node",
  entry,
  nonce: "f".repeat(32),
}

function procView(overrides: {
  stat?: string
  exe?: string
  argv?: string[]
  environ?: string[]
  unreadable?: boolean
}): ProcessInspection {
  const files: Record<string, string> = {
    "/proc/4242/stat":
      overrides.stat ??
      `4242 (node (server)) S 4000 ${"0 ".repeat(17)}777001 0 0`,
    "/proc/4242/cmdline": `${(
      overrides.argv ?? ["/usr/bin/node", "--import", "tsx", entry]
    ).join("\0")}\0`,
    "/proc/4242/environ": `${(
      overrides.environ ?? [
        "PATH=/usr/bin",
        `${SERVER_NONCE_VARIABLE}=${"f".repeat(32)}`,
      ]
    ).join("\0")}\0`,
  }
  return {
    readFile: async (candidate) => {
      if (overrides.unreadable) throw new Error("EACCES")
      const contents = files[candidate]
      if (contents === undefined) throw new Error("ENOENT")
      return Buffer.from(contents)
    },
    readlink: async () => overrides.exe ?? "/usr/bin/node",
  }
}

describe("owned server identity", () => {
  it("accepts exactly the direct, nonce-bearing node child running server.ts", async () => {
    expect(await inspectOwnedServer(4242, expected, procView({}))).toEqual({
      pid: 4242,
      ppid: 4000,
      startTime: "777001",
      state: "S",
    })
  })

  it.each([
    [
      "a non-child process",
      { stat: `4242 (node) S 1 ${"0 ".repeat(17)}777001` },
      "NOT_DIRECT_CHILD",
    ],
    [
      "a zombie",
      { stat: `4242 (node) Z 4000 ${"0 ".repeat(17)}777001` },
      "NOT_RUNNING",
    ],
    [
      "a different pid in stat",
      { stat: `999 (node) S 4000 ${"0 ".repeat(17)}777001` },
      "STAT_MISMATCH",
    ],
    ["another executable", { exe: "/usr/bin/python3" }, "EXECUTABLE_MISMATCH"],
    [
      "an npm wrapper",
      {
        argv: [
          "/usr/bin/node",
          "/usr/lib/node_modules/npm/bin/npm-cli.js",
          "run",
          "start",
        ],
      },
      "ARGV_MISMATCH",
    ],
    [
      "a tsx CLI wrapper",
      { argv: ["/usr/bin/node", "/repo/node_modules/tsx/dist/cli.mjs", entry] },
      "ARGV_MISMATCH",
    ],
    [
      "another entry",
      { argv: ["/usr/bin/node", "--import", "tsx", "/repo/other.ts"] },
      "ARGV_MISMATCH",
    ],
    [
      "extra arguments",
      { argv: ["/usr/bin/node", "--import", "tsx", entry, "--x"] },
      "ARGV_MISMATCH",
    ],
    ["a missing nonce", { environ: ["PATH=/usr/bin"] }, "NONCE_MISMATCH"],
    [
      "a nonce prefix",
      { environ: [`${SERVER_NONCE_VARIABLE}=${"f".repeat(32)}0`] },
      "NONCE_MISMATCH",
    ],
    [
      "a nonce in another variable",
      { environ: [`OTHER=${"f".repeat(32)}`] },
      "NONCE_MISMATCH",
    ],
    ["an unreadable /proc", { unreadable: true }, "PROC_UNREADABLE"],
  ])("rejects %s", async (_kind, overrides, reason) => {
    await expect(
      inspectOwnedServer(4242, expected, procView(overrides)),
    ).rejects.toMatchObject({ reason })
  })

  it.each([0, 1, -5, Number.NaN])("rejects pid %s", async (pid) => {
    await expect(
      inspectOwnedServer(pid, expected, procView({})),
    ).rejects.toMatchObject({ reason: "PID_INVALID" })
  })

  function fakeServer(child: Partial<OwnedServer["child"]>): OwnedServer {
    return {
      child: {
        pid: 4242,
        exitCode: null,
        signalCode: null,
        kill: vi.fn(() => true),
        ...child,
      } as unknown as OwnedServer["child"],
      expected,
      identity: { pid: 4242, ppid: 4000, startTime: "777001", state: "S" },
      exited: new Promise(() => undefined),
      stdoutLines: [],
    }
  }

  it("rejects a reused PID (same number, different start time)", async () => {
    await expect(
      reverifyOwnedServer(
        fakeServer({}),
        procView({ stat: `4242 (node) S 4000 ${"0 ".repeat(17)}888002` }),
      ),
    ).rejects.toMatchObject({ reason: "PID_REUSED" })
  })

  it.each([
    ["an exited handle", { exitCode: 0 }, "ALREADY_EXITED"],
    [
      "a signalled handle",
      { signalCode: "SIGKILL" as const },
      "ALREADY_EXITED",
    ],
    ["a different handle pid", { pid: 5151 }, "HANDLE_PID_CHANGED"],
  ])("rejects %s before any signal", async (_kind, child, reason) => {
    await expect(
      reverifyOwnedServer(fakeServer(child), procView({})),
    ).rejects.toMatchObject({ reason })
  })

  it("never signals anything while the real gate is off", async () => {
    const server = fakeServer({})
    await expect(
      crashOwnedServer(server, {}, procView({})),
    ).rejects.toMatchObject({
      reason: "REAL_GATE_DISABLED",
    })
    await expect(
      freezeOwnedServer(
        server,
        { ...allGates, [B2_REAL_GATE]: "0" },
        procView({}),
      ),
    ).rejects.toMatchObject({
      reason: "REAL_GATE_DISABLED",
    })
    await expect(
      thawOwnedServer(server, {}, procView({})),
    ).rejects.toMatchObject({
      reason: "REAL_GATE_DISABLED",
    })
    expect(server.child.kill).not.toHaveBeenCalled()
  })

  it("accepts only termination by SIGKILL as a crash", () => {
    expect(classifyExit({ code: null, signal: "SIGKILL" })).toEqual({
      kind: "CRASHED",
    })
    expect(classifyExit({ code: 0, signal: null })).toEqual({
      kind: "INCONCLUSIVE",
      reason: "NORMAL_EXIT",
    })
    expect(classifyExit({ code: 1, signal: null })).toEqual({
      kind: "INCONCLUSIVE",
      reason: "NORMAL_EXIT",
    })
    expect(classifyExit({ code: null, signal: "SIGTERM" })).toEqual({
      kind: "INCONCLUSIVE",
      reason: "SIGNAL_SIGTERM",
    })
    expect(classifyExit(null)).toEqual({
      kind: "INCONCLUSIVE",
      reason: "EXIT_TIMEOUT",
    })
  })

  // Real /proc on Linux CI with a harmless idle child (never the server,
  // never SIGKILL): proves the identity parsing against the actual kernel.
  it.runIf(process.platform === "linux")(
    "identifies a real harness-spawned node --import tsx child and classifies SIGTERM as not a crash",
    async () => {
      const nonce = "e".repeat(32)
      const childEntry = path.resolve("tests/support/b2IdleChild.ts")
      const server = await spawnOwnedServer({
        repository: process.cwd(),
        entry: childEntry,
        environment: {
          PATH: process.env.PATH ?? "",
          [SERVER_NONCE_VARIABLE]: nonce,
        },
        nonce,
      })
      try {
        expect(server.identity.ppid).toBe(process.pid)
        const again = await reverifyOwnedServer(server, linuxProcessInspection)
        expect(again.startTime).toBe(server.identity.startTime)
        await expect(
          inspectOwnedServer(
            server.identity.pid,
            { ...server.expected, nonce: "d".repeat(32) },
            linuxProcessInspection,
          ),
        ).rejects.toMatchObject({ reason: "NONCE_MISMATCH" })
        await expect(
          inspectOwnedServer(
            process.pid,
            server.expected,
            linuxProcessInspection,
          ),
        ).rejects.toMatchObject({ reason: "NOT_DIRECT_CHILD" })
      } finally {
        server.child.kill("SIGTERM")
      }
      // SIGTERM may land before the child installs its handler (default
      // termination) or after (exit 0); neither is ever a crash.
      const outcome = classifyExit(await server.exited)
      expect(outcome.kind).toBe("INCONCLUSIVE")
      expect(["NORMAL_EXIT", "SIGNAL_SIGTERM"]).toContain(
        outcome.kind === "INCONCLUSIVE" ? outcome.reason : "CRASHED",
      )
      await expect(
        reverifyOwnedServer(server, linuxProcessInspection),
      ).rejects.toMatchObject({
        reason: "ALREADY_EXITED",
      })
    },
    30_000,
  )
})

const roots: ServerRoots = {
  baseRootfs: "/srv/m12/rootfs",
  bundlesDir: "/srv/m12/workspace/run-1/bundles",
  runscRoot: "/srv/m12/runsc/run-1/state",
  networkLeaseDir: "/srv/m12/workspace/run-1/network-leases",
  generatedSecretRoot: "/srv/m12/tmpfs/run-1/secrets",
  artifactStorageDir: "/srv/m12/workspace/run-1/artifacts",
  databaseCredentialRoot: "/srv/m12/tmpfs/run-1/db-credentials",
  userEnvironmentRoot: "/srv/m12/tmpfs/run-1/user-env",
}
const approved = [
  "/srv/m12/workspace/run-1",
  "/srv/m12/runsc/run-1",
  "/srv/m12/tmpfs/run-1",
  "/srv/m12/rootfs",
]

describe("test-owned server environment", () => {
  const secrets = syntheticServerSecrets()
  const build = (overrides?: Partial<Record<string, string>>) =>
    buildServerEnvironment({
      databaseUrl: "postgresql://b2:synthetic@127.0.0.1:5432/peephole_b2_test",
      roots,
      ports: { api: 41001, artifact: 41002, tlsAsk: 41003 },
      secrets,
      nonce: "c".repeat(32),
      overrides,
    })

  it("does not inherit the operator environment", () => {
    process.env.B2_SHOULD_NOT_LEAK = "operator-value"
    try {
      const environment = build()
      expect(environment.B2_SHOULD_NOT_LEAK).toBeUndefined()
      expect(Object.values(environment)).not.toContain("operator-value")
      expect(environment.PEEPHOLE_GITHUB_TOKEN).toBeUndefined()
    } finally {
      delete process.env.B2_SHOULD_NOT_LEAK
    }
  })

  it("is accepted by the real production, API and OAuth config parsers with every root in test scope", () => {
    const environment = build()
    const config = readProductionConfig(environment)
    expect(config.networkLeaseDir).toBe(roots.networkLeaseDir)
    expect(config.userEnvironment).toEqual({
      enabled: true,
      rootDir: roots.userEnvironmentRoot,
    })
    expect(config.temporaryDatabases.enabled).toBe(false)
    expect(config.runscRootDir).toBe(roots.runscRoot)
    expect(readPreviewApiServerConfig(environment)).toMatchObject({
      host: "127.0.0.1",
      port: 41001,
    })
    expect(() => readGitHubAppOAuthConfig(environment)).not.toThrow()
    expect(() => assertRootsWithin(roots, approved)).not.toThrow()
  })

  it("applies explicit overrides (the R0 startup-failure injection)", () => {
    expect(
      build({ PEEPHOLE_GENERATED_SECRET_ROOT: "/srv/m12/workspace/run-1/r0" })
        .PEEPHOLE_GENERATED_SECRET_ROOT,
    ).toBe("/srv/m12/workspace/run-1/r0")
  })

  it.each([
    [
      "a Production lease directory",
      { networkLeaseDir: "/var/run/peephole/net-leases" },
    ],
    [
      "a sibling-prefix directory",
      { bundlesDir: "/srv/m12/workspace/run-10/bundles" },
    ],
    [
      "a Production user-env root",
      { userEnvironmentRoot: "/run/peephole/user-env" },
    ],
  ])("refuses %s outside the approved test scope", (_kind, override) => {
    expect(() =>
      assertRootsWithin({ ...roots, ...override }, approved),
    ).toThrow(/ROOT_OUTSIDE_TEST_SCOPE/)
  })
})

describe("operator-supplied B2 inputs", () => {
  const fixture = {
    repositoryId: 1,
    owner: "example",
    name: "fixture",
    commitSha: "a".repeat(40),
    frontendSourceRoot: "web",
    backendSourceRoot: "api",
    environmentNames: ["PUBLIC_MODE"],
  }

  it("parses a public fixture at an exact commit", () => {
    expect(parseB2Fixture(JSON.stringify(fixture))).toEqual(fixture)
  })

  it.each([
    undefined,
    "not json",
    JSON.stringify({ ...fixture, commitSha: "main" }),
    JSON.stringify({ ...fixture, environmentNames: [] }),
    JSON.stringify({ ...fixture, environmentNames: ["lower"] }),
    JSON.stringify({ ...fixture, repositoryId: 0 }),
    JSON.stringify({ ...fixture, owner: "a/b" }),
  ])("rejects an invalid fixture %#", (raw) => {
    expect(() => parseB2Fixture(raw)).toThrow("B2_FIXTURE_INVALID")
  })

  it("derives distinct synthetic values per run", () => {
    expect(syntheticEnvironment(["A", "B"], "tag")).toEqual([
      { name: "A", value: "b2-synthetic-tag-0" },
      { name: "B", value: "b2-synthetic-tag-1" },
    ])
  })

  it.each([
    "postgresql://u:p@127.0.0.1:5432/peephole_b2_test",
    "postgres://u:p@localhost/peephole_b2_test_1",
  ])("accepts a dedicated loopback test database %#", (url) => {
    expect(assertDedicatedTestDatabaseUrl(url)).toBe(url)
  })

  it.each([
    undefined,
    "postgresql://u:p@db.internal:5432/peephole_b2_test",
    "postgresql://u:p@10.0.0.5/peephole_b2_test",
    "postgresql://u:p@127.0.0.1/peephole",
    "postgresql://u:p@127.0.0.1/postgres",
    "mysql://u:p@127.0.0.1/peephole_b2_test",
    "postgresql://u:p@/peephole_b2_test?host=/var/run/postgresql",
  ])("refuses a non-dedicated database %#", (url) => {
    expect(() => assertDedicatedTestDatabaseUrl(url)).toThrow(
      "B2_TEST_DATABASE_INVALID",
    )
  })
})

describe("B2 boundary and verdict classification", () => {
  const frozen = {
    frozen: true,
    aStatus: "ready",
    aRouteStatus: 200,
    bStatus: "queued",
    bQueueStatus: "queued",
    cStatus: "building_frontend",
  }

  it("requires a frozen server, a served ready A and a queued B", () => {
    expect(classifyBoundary(frozen)).toEqual({
      h1: true,
      h2: true,
      auxiliary: true,
    })
    expect(classifyBoundary({ ...frozen, frozen: false })).toEqual({
      h1: false,
      h2: false,
      auxiliary: false,
    })
    expect(classifyBoundary({ ...frozen, aRouteStatus: 404 }).h2).toBe(false)
    expect(
      classifyBoundary({ ...frozen, aStatus: "starting_backend" }).h2,
    ).toBe(false)
    expect(
      classifyBoundary({ ...frozen, bStatus: "building_frontend" }).h1,
    ).toBe(false)
    expect(classifyBoundary({ ...frozen, bQueueStatus: "leased" }).h1).toBe(
      false,
    )
    expect(classifyBoundary({ ...frozen, cStatus: "ready" }).auxiliary).toBe(
      false,
    )
  })

  const h1: H1Facts = {
    crash: { kind: "CRASHED" },
    freshProcess: true,
    boundaryReached: true,
    bStatus: "failed",
    bErrorCode: "CONFIGURATION_UNAVAILABLE",
    bEverReady: false,
    userEnvironmentDelivered: false,
  }

  it.each([
    ["the proven fail-closed result", {}, "PASS", "CONFIGURATION_UNAVAILABLE"],
    [
      "an unproven boundary",
      { boundaryReached: false },
      "INCONCLUSIVE",
      "BOUNDARY_NOT_REACHED",
    ],
    [
      "a graceful stop instead of SIGKILL",
      { crash: { kind: "INCONCLUSIVE" as const, reason: "NORMAL_EXIT" } },
      "INCONCLUSIVE",
      "CRASH_NORMAL_EXIT",
    ],
    [
      "an unproven restart",
      { freshProcess: false },
      "INCONCLUSIVE",
      "NO_FRESH_PROCESS",
    ],
    [
      "a run that became ready",
      { bEverReady: true },
      "FAIL",
      "RAN_WITHOUT_ADMITTED_VALUES",
    ],
    [
      "a ready terminal state",
      { bStatus: "ready", bErrorCode: null },
      "FAIL",
      "RAN_WITHOUT_ADMITTED_VALUES",
    ],
    [
      "delivered user-environment material",
      { userEnvironmentDelivered: true },
      "FAIL",
      "MATERIAL_DELIVERED",
    ],
    [
      "an unreadable material inventory",
      { userEnvironmentDelivered: null },
      "INCONCLUSIVE",
      "MATERIAL_INVENTORY_UNREADABLE",
    ],
    [
      "ORCHESTRATION_UNAVAILABLE (not a substitute)",
      { bErrorCode: "ORCHESTRATION_UNAVAILABLE" },
      "INCONCLUSIVE",
      "CONSUMPTION_BOUNDARY_NOT_PROVEN",
    ],
    [
      "a frontend failure",
      { bErrorCode: "FRONTEND_FAILED" },
      "INCONCLUSIVE",
      "CONSUMPTION_BOUNDARY_NOT_PROVEN",
    ],
    [
      "no terminal state",
      { bStatus: null, bErrorCode: null },
      "INCONCLUSIVE",
      "CONSUMPTION_BOUNDARY_NOT_PROVEN",
    ],
  ])("H1: %s", (_kind, override, verdict, code) => {
    expect(classifyH1({ ...h1, ...override })).toEqual({ verdict, code })
  })

  const clean = Object.fromEntries(
    OWNED_RESOURCE_KINDS.map((kind) => [kind, 0]),
  ) as H2Facts["resources"]
  const h2: H2Facts = {
    crash: { kind: "CRASHED" },
    freshProcess: true,
    boundaryReached: true,
    aStatusAtFirstResponse: "failed",
    aErrorCode: "ORCHESTRATION_UNAVAILABLE",
    aQueueStatus: "cancelled",
    aRouteStatusAfter: 404,
    resources: clean,
    repeatedReap: { changed: 0, failed: false },
    listenerGatedOnFailedRecovery: true,
  }

  it.each([
    ["full recovery", {}, "PASS", "RECOVERED"],
    ["a removed queue row", { aQueueStatus: null }, "PASS", "RECOVERED"],
    [
      "an unproven boundary",
      { boundaryReached: false },
      "INCONCLUSIVE",
      "BOUNDARY_NOT_REACHED",
    ],
    [
      "a SIGTERM instead of SIGKILL",
      { crash: { kind: "INCONCLUSIVE" as const, reason: "SIGNAL_SIGTERM" } },
      "INCONCLUSIVE",
      "CRASH_SIGNAL_SIGTERM",
    ],
    [
      "a stale ready row served",
      { aStatusAtFirstResponse: "ready" },
      "FAIL",
      "STALE_READY_SERVED",
    ],
    [
      "a stale route served",
      { aRouteStatusAfter: 200 },
      "FAIL",
      "STALE_ROUTE_SERVED",
    ],
    [
      "a retained queue delivery",
      { aQueueStatus: "leased" },
      "FAIL",
      "QUEUE_DELIVERY_RETAINED",
    ],
    [
      "a remaining loop device",
      { resources: { ...clean, loopDevices: 1 } },
      "FAIL",
      "OWNED_RESOURCE_REMAINS",
    ],
    [
      "a remaining veth",
      { resources: { ...clean, hostLinks: 1 } },
      "FAIL",
      "OWNED_RESOURCE_REMAINS",
    ],
    [
      "remaining M12 material",
      { resources: { ...clean, userEnvironmentFiles: 1 } },
      "FAIL",
      "OWNED_RESOURCE_REMAINS",
    ],
    [
      "a FAIL hidden behind an unreadable area",
      {
        resources: { ...clean, runscContainers: null, generatedSecretFiles: 2 },
      },
      "FAIL",
      "OWNED_RESOURCE_REMAINS",
    ],
    [
      "a non-idempotent reaper",
      { repeatedReap: { changed: 1, failed: false } },
      "FAIL",
      "REAPER_NOT_IDEMPOTENT",
    ],
    [
      "a failed repeated reaper",
      { repeatedReap: { changed: 0, failed: true } },
      "FAIL",
      "REAPER_NOT_IDEMPOTENT",
    ],
    [
      "a listener opened after failed recovery",
      { listenerGatedOnFailedRecovery: false },
      "FAIL",
      "LISTENER_OPENED_AFTER_FAILED_RECOVERY",
    ],
    [
      "an unreadable inventory area",
      { resources: { ...clean, newMounts: null } },
      "INCONCLUSIVE",
      "EVIDENCE_INCOMPLETE",
    ],
    [
      "no repeated reap",
      { repeatedReap: null },
      "INCONCLUSIVE",
      "EVIDENCE_INCOMPLETE",
    ],
    [
      "an unreachable artifact host",
      { aRouteStatusAfter: null },
      "INCONCLUSIVE",
      "EVIDENCE_INCOMPLETE",
    ],
    [
      "an untested listener gate",
      { listenerGatedOnFailedRecovery: null },
      "INCONCLUSIVE",
      "EVIDENCE_INCOMPLETE",
    ],
    [
      "an unexpected parent result",
      { aErrorCode: "BACKEND_FAILED" },
      "INCONCLUSIVE",
      "RECONCILIATION_NOT_PROVEN",
    ],
  ])("H2: %s", (_kind, override, verdict, code) => {
    expect(classifyH2({ ...h2, ...override })).toEqual({ verdict, code })
  })
})

describe("fresh process broker (portable model of a restart)", () => {
  it("a new broker instance cannot return, compare or deliver values admitted by the previous one", () => {
    const before = new InMemoryUserEnvironmentBroker()
    const binding = {
      previewId: "fullstack-b2portable01",
      requesterId: "b2-requester",
      repository: {
        repositoryId: 1,
        owner: "example",
        name: "fixture",
        commitSha: "a".repeat(40),
      },
      backendSourceRoot: "api",
      names: ["PUBLIC_MODE"],
    }
    const entries = [{ name: "PUBLIC_MODE", value: "b2-synthetic-x-0" }]
    before.register(binding, entries, new Date(Date.now() + 60_000))
    expect(
      before.compare(binding.previewId, binding.requesterId, entries),
    ).toBe("same")

    // The server keeps the broker only in process memory; a restart builds a
    // new instance. (Real cross-process evidence is the Linux-only suite.)
    const after = new InMemoryUserEnvironmentBroker()
    expect(after.compare(binding.previewId, binding.requesterId, entries)).toBe(
      "unknown",
    )
    expect(
      after.take(binding.previewId, {
        runtimeId: "runtime-b2portable",
        repository: binding.repository,
        backendSourceRoot: binding.backendSourceRoot,
        names: binding.names,
      }),
    ).toBeNull()
  })
})

describe("B2 evidence", () => {
  const record = {
    schema: "peephole-b2-server-crash/v1" as const,
    scenario: "H2" as const,
    verdict: "PASS" as const,
    code: "RECOVERED",
    sourceSha: "b".repeat(40),
    stages: ["sigkill", "fresh-start"],
    counts: { loopDevices: 0 },
  }

  it("emits only codes, verdicts, stages, counts and the source SHA", () => {
    const line = formatB2Evidence(record, ["secret-value"])
    expect(line.startsWith("[b2-server-crash-evidence] ")).toBe(true)
    expect(
      Object.keys(
        JSON.parse(line.slice(line.indexOf(" ") + 1)) as object,
      ).sort(),
    ).toEqual([
      "code",
      "counts",
      "scenario",
      "schema",
      "sourceSha",
      "stages",
      "verdict",
    ])
  })

  it("refuses evidence that contains a sensitive run value", () => {
    expect(() =>
      formatB2Evidence({ ...record, code: "leak-b2-synthetic-x-0" }, [
        "b2-synthetic-x-0",
      ]),
    ).toThrow("B2_EVIDENCE_CONTAINS_SENSITIVE_VALUE")
    expect(() =>
      formatB2Evidence({ ...record, sourceSha: "main" }, []),
    ).toThrow("B2_EVIDENCE_SOURCE_SHA_INVALID")
  })
})
