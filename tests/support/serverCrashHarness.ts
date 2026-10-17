/** B2 test-owned production server child (test-only).
 *
 * The child is the unmodified `services/production/server.ts`, started as
 * `node --import tsx <entry>` by this harness (no npm/tsx wrapper process:
 * tsx's `--import` loader runs inside the same Node process, so the
 * ChildProcess PID is the server). Ownership is proven from that handle plus
 * `/proc` facts -- never by searching process names or broad PID ranges.
 * Every signal path re-verifies ownership first. SIGSTOP/SIGKILL are only
 * reachable behind `realServerCrashEnabled` (exact "1"), which is off in
 * Portable runs and CI. No raw environment value, URL, token, nonce or
 * command output is ever placed in evidence. */
import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { readFile, readlink, realpath } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { createServer, Socket } from "node:net"

import { m12RealSuiteEnabled } from "./m12RealGvisorHarness"

export const B2_REAL_GATE = "PEEPHOLE_B2_REAL_SERVER_CRASH"
export const SERVER_NONCE_VARIABLE = "PEEPHOLE_B2_TEST_SERVER_NONCE"
export const SERVER_LISTENING_MARKER = "[peephole] preview API listening on"

/** Exactly "1" for the B2 gate AND both existing M12 real gates (whose test
 * roots the server reuses), on Linux. "0", empty or unset never enables it. */
export function realServerCrashEnabled(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    platform === "linux" &&
    environment[B2_REAL_GATE] === "1" &&
    m12RealSuiteEnabled(environment)
  )
}

// ------------------------------------------------------- Process identity

export interface ProcessInspection {
  readFile(candidate: string): Promise<Buffer>
  readlink(candidate: string): Promise<string>
}

export const linuxProcessInspection: ProcessInspection = {
  readFile: (candidate) => readFile(candidate),
  readlink: (candidate) => readlink(candidate),
}

export interface ExpectedServer {
  harnessPid: number
  /** realpath of process.execPath (the node binary the harness spawned). */
  executable: string
  /** Absolute path of services/production/server.ts. */
  entry: string
  nonce: string
}

export interface OwnedServerIdentity {
  pid: number
  ppid: number
  startTime: string
  state: string
}

export class ServerOwnershipError extends Error {
  constructor(readonly reason: string) {
    super(`B2_OWNERSHIP_${reason}`)
    this.name = "ServerOwnershipError"
  }
}

function statFields(stat: string) {
  // proc(5): `pid (comm) state ppid ... starttime(22)`; comm may contain
  // spaces/parentheses, so count fields after the LAST ")".
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(" ")
  return {
    state: fields[0] ?? "",
    ppid: Number(fields[1]),
    startTime: fields[19] ?? "",
  }
}

/** Reads `/proc/<pid>` and proves it is exactly the server this harness
 * spawned: direct child (PPID), the node executable, argv
 * `[node, --import, tsx, <entry>]` (so no wrapper), and the per-run nonce
 * as an exact environment entry. Values are compared, never returned. */
export async function inspectOwnedServer(
  pid: number,
  expected: ExpectedServer,
  inspection: ProcessInspection,
): Promise<OwnedServerIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 1)
    throw new ServerOwnershipError("PID_INVALID")
  let stat: string
  let executable: string
  let argv: string[]
  let environ: string[]
  try {
    stat = (await inspection.readFile(`/proc/${String(pid)}/stat`)).toString()
    executable = await inspection.readlink(`/proc/${String(pid)}/exe`)
    argv = (await inspection.readFile(`/proc/${String(pid)}/cmdline`))
      .toString()
      .split("\0")
    environ = (await inspection.readFile(`/proc/${String(pid)}/environ`))
      .toString()
      .split("\0")
  } catch {
    throw new ServerOwnershipError("PROC_UNREADABLE")
  }
  const fields = statFields(stat)
  if (!stat.startsWith(`${String(pid)} (`))
    throw new ServerOwnershipError("STAT_MISMATCH")
  if (fields.ppid !== expected.harnessPid)
    throw new ServerOwnershipError("NOT_DIRECT_CHILD")
  if (!/^[0-9]+$/.test(fields.startTime))
    throw new ServerOwnershipError("START_TIME_INVALID")
  if (fields.state === "Z" || fields.state === "X")
    throw new ServerOwnershipError("NOT_RUNNING")
  if (executable !== expected.executable)
    throw new ServerOwnershipError("EXECUTABLE_MISMATCH")
  if (argv.at(-1) === "") argv.pop()
  if (
    argv.length !== 4 ||
    argv[1] !== "--import" ||
    argv[2] !== "tsx" ||
    argv[3] !== expected.entry
  )
    throw new ServerOwnershipError("ARGV_MISMATCH")
  if (!environ.includes(`${SERVER_NONCE_VARIABLE}=${expected.nonce}`))
    throw new ServerOwnershipError("NONCE_MISMATCH")
  return {
    pid,
    ppid: fields.ppid,
    startTime: fields.startTime,
    state: fields.state,
  }
}

export interface OwnedServer {
  child: ChildProcess
  expected: ExpectedServer
  identity: OwnedServerIdentity
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  /** Bounded, in-memory only; never written to evidence or logs. */
  stdoutLines: string[]
}

/** Re-proves ownership immediately before any signal: same handle PID, still
 * not exited, and the same `/proc` start time (rejects PID reuse/replacement). */
export async function reverifyOwnedServer(
  server: OwnedServer,
  inspection: ProcessInspection,
): Promise<OwnedServerIdentity> {
  const { child, identity } = server
  if (child.pid !== identity.pid)
    throw new ServerOwnershipError("HANDLE_PID_CHANGED")
  if (child.exitCode !== null || child.signalCode !== null)
    throw new ServerOwnershipError("ALREADY_EXITED")
  const current = await inspectOwnedServer(
    identity.pid,
    server.expected,
    inspection,
  )
  if (current.startTime !== identity.startTime)
    throw new ServerOwnershipError("PID_REUSED")
  return current
}

// ------------------------------------------------------ Spawning the child

export interface ServerRoots {
  baseRootfs: string
  bundlesDir: string
  runscRoot: string
  networkLeaseDir: string
  generatedSecretRoot: string
  artifactStorageDir: string
  databaseCredentialRoot: string
  userEnvironmentRoot: string
}

export interface ServerPorts {
  api: number
  artifact: number
  tlsAsk: number
}

export interface ServerSecrets {
  sessionSigningSecret: string
  oauthClientSecret: string
  oauthStateSecret: string
}

export function syntheticServerSecrets(): ServerSecrets {
  return {
    sessionSigningSecret: randomBytes(32).toString("hex"),
    oauthClientSecret: randomBytes(32).toString("hex"),
    oauthStateSecret: randomBytes(32).toString("hex"),
  }
}

/** A fresh, allowlisted environment: the operator's own environment is NOT
 * inherited, so no Production credential or path can reach the child. M12 is
 * on, M11 off (no tenant database), and every resource root is a test root. */
export function buildServerEnvironment(input: {
  databaseUrl: string
  roots: ServerRoots
  ports: ServerPorts
  secrets: ServerSecrets
  nonce: string
  overrides?: Partial<Record<string, string>>
}): NodeJS.ProcessEnv {
  const { roots, ports, secrets } = input
  const environment: Record<string, string> = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C.UTF-8",
    HOME: "/root",
    PEEPHOLE_DATABASE_URL: input.databaseUrl,
    PEEPHOLE_SESSION_SIGNING_SECRET: secrets.sessionSigningSecret,
    PEEPHOLE_GITHUB_APP_CLIENT_ID: "b2-synthetic-client",
    PEEPHOLE_GITHUB_APP_CLIENT_SECRET: secrets.oauthClientSecret,
    PEEPHOLE_GITHUB_OAUTH_STATE_SECRET: secrets.oauthStateSecret,
    PEEPHOLE_GITHUB_APP_CALLBACK_URL: `http://127.0.0.1:${String(ports.api)}/v1/auth/github/callback`,
    PEEPHOLE_ALLOWED_EXTENSION_IDS: "a".repeat(32),
    PEEPHOLE_API_HOST: "127.0.0.1",
    PEEPHOLE_API_PORT: String(ports.api),
    PEEPHOLE_ARTIFACT_PORT: String(ports.artifact),
    PEEPHOLE_ARTIFACT_TLS_ASK_PORT: String(ports.tlsAsk),
    PEEPHOLE_GVISOR_BASE_ROOTFS: roots.baseRootfs,
    PEEPHOLE_GVISOR_BUNDLES_DIR: roots.bundlesDir,
    PEEPHOLE_GVISOR_RUNSC_ROOT: roots.runscRoot,
    PEEPHOLE_NETWORK_LEASE_DIR: roots.networkLeaseDir,
    PEEPHOLE_GENERATED_SECRET_ROOT: roots.generatedSecretRoot,
    PEEPHOLE_ARTIFACT_STORAGE_DIR: roots.artifactStorageDir,
    PEEPHOLE_DATABASE_CREDENTIAL_ROOT: roots.databaseCredentialRoot,
    PEEPHOLE_USER_ENVIRONMENT_ROOT: roots.userEnvironmentRoot,
    PEEPHOLE_USER_ENVIRONMENT: "1",
    PEEPHOLE_TEMPORARY_DATABASES: "0",
    [SERVER_NONCE_VARIABLE]: input.nonce,
  }
  for (const [name, value] of Object.entries(input.overrides ?? {}))
    if (value !== undefined) environment[name] = value
  return environment
}

/** Every configured root must lie inside an approved test run directory. */
export function assertRootsWithin(
  roots: ServerRoots,
  approved: readonly string[],
): void {
  for (const value of Object.values(roots)) {
    if (
      !approved.some((root) => value === root || value.startsWith(`${root}/`))
    )
      throw new ServerOwnershipError("ROOT_OUTSIDE_TEST_SCOPE")
  }
}

const MAX_STDOUT_LINES = 200

/** A spawned child whose identity could not be proven. It is never
 * signalled by the harness; the run is INCONCLUSIVE, the handle is kept so
 * its exit can still be observed, and the test roots are preserved for
 * manual inspection while it may be alive. */
export interface UnverifiedChild {
  child: ChildProcess
  exited: OwnedServer["exited"]
  reason: string
}

export type SpawnResult =
  | { kind: "OWNED"; server: OwnedServer }
  | { kind: "UNVERIFIED"; unverified: UnverifiedChild }

export async function spawnOwnedServer(input: {
  repository: string
  entry: string
  environment: NodeJS.ProcessEnv
  nonce: string
  inspection?: ProcessInspection
}): Promise<SpawnResult> {
  const executable = await realpath(process.execPath)
  const child = spawn(executable, ["--import", "tsx", input.entry], {
    cwd: input.repository,
    env: input.environment,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const exited = new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
  }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  )
  const stdoutLines: string[] = []
  let partial = ""
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = partial + chunk.toString()
    const lines = text.split("\n")
    partial = lines.pop() ?? ""
    for (const line of lines)
      if (stdoutLines.length < MAX_STDOUT_LINES) stdoutLines.push(line)
  })
  // stderr is drained, never forwarded: startup errors can echo config.
  child.stderr?.resume()
  const expected: ExpectedServer = {
    harnessPid: process.pid,
    executable,
    entry: input.entry,
    nonce: input.nonce,
  }
  const pid = child.pid
  if (pid === undefined)
    return {
      kind: "UNVERIFIED",
      unverified: { child, exited, reason: "SPAWN_FAILED" },
    }
  try {
    const identity = await inspectOwnedServer(
      pid,
      expected,
      input.inspection ?? linuxProcessInspection,
    )
    return {
      kind: "OWNED",
      server: { child, expected, identity, exited, stdoutLines },
    }
  } catch (error) {
    return {
      kind: "UNVERIFIED",
      unverified: {
        child,
        exited,
        reason:
          error instanceof ServerOwnershipError ? error.reason : "OWNERSHIP",
      },
    }
  }
}

export function newServerNonce(): string {
  return randomBytes(16).toString("hex")
}

// ------------------------------------------------- Signal boundary control

export type CrashOutcome =
  { kind: "CRASHED" } | { kind: "INCONCLUSIVE"; reason: string }

function requireGate(environment: NodeJS.ProcessEnv): void {
  if (!realServerCrashEnabled(environment))
    throw new ServerOwnershipError("REAL_GATE_DISABLED")
}

/** SIGSTOP freezes the owned server so the durable state observed next is
 * exactly the state at the kill. Returns only after `/proc` shows "T". */
export async function freezeOwnedServer(
  server: OwnedServer,
  environment: NodeJS.ProcessEnv,
  inspection: ProcessInspection = linuxProcessInspection,
): Promise<void> {
  requireGate(environment)
  await reverifyOwnedServer(server, inspection)
  server.child.kill("SIGSTOP")
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = await reverifyOwnedServer(server, inspection)
    if (current.state === "T") return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new ServerOwnershipError("NOT_STOPPED")
}

/** Resumes a frozen server whose boundary was NOT reached; the run is then
 * stopped gracefully and classified INCONCLUSIVE, never as a crash. */
export async function thawOwnedServer(
  server: OwnedServer,
  environment: NodeJS.ProcessEnv,
  inspection: ProcessInspection = linuxProcessInspection,
): Promise<void> {
  requireGate(environment)
  await reverifyOwnedServer(server, inspection)
  server.child.kill("SIGCONT")
}

/** The only crash path: re-verify, SIGKILL the exact owned PID, and accept
 * the result only when the handle reports termination by SIGKILL. A normal
 * exit (code), SIGTERM or any other signal is INCONCLUSIVE. */
export async function crashOwnedServer(
  server: OwnedServer,
  environment: NodeJS.ProcessEnv,
  inspection: ProcessInspection = linuxProcessInspection,
  timeoutMs = 10_000,
): Promise<CrashOutcome> {
  requireGate(environment)
  try {
    await reverifyOwnedServer(server, inspection)
  } catch (error) {
    return {
      kind: "INCONCLUSIVE",
      reason:
        error instanceof ServerOwnershipError ? error.reason : "OWNERSHIP",
    }
  }
  server.child.kill("SIGKILL")
  return classifyExit(
    await Promise.race([
      server.exited,
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), timeoutMs),
      ),
    ]),
  )
}

/** Normal stop of an owned server: re-verify, then SIGTERM. Not gated
 * (it is the ordinary shutdown path) and never evidence of a crash. Returns
 * the exit, or null on timeout; an unprovable identity sends nothing. */
export async function stopOwnedServer(
  server: OwnedServer,
  inspection: ProcessInspection = linuxProcessInspection,
  timeoutMs = 120_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
  await reverifyOwnedServer(server, inspection)
  server.child.kill("SIGTERM")
  return Promise.race([
    server.exited,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ])
}

/** A fresh server may start only after a confirmed SIGKILL exit. Any other
 * outcome (unprovable ownership, exit timeout, normal exit, SIGTERM) means the
 * first server may still be alive and sharing the database, ports and roots:
 * no second server, no recovery, H1/H2 INCONCLUSIVE. */
export function freshStartupDecision(
  crash: CrashOutcome,
): { allowed: true } | { allowed: false; code: string } {
  return crash.kind === "CRASHED"
    ? { allowed: true }
    : { allowed: false, code: `CRASH_${crash.reason}` }
}

/** Teardown policy: every signal goes through re-verified helpers; an owned
 * server that cannot be re-proven, does not stop, or any unverified child that
 * may still be alive leaves `manualInspection` set, and the caller must then
 * preserve the test roots instead of releasing them. */
export async function teardownServerChildren(input: {
  servers: readonly OwnedServer[]
  unverified: readonly UnverifiedChild[]
  environment: NodeJS.ProcessEnv
  inspection?: ProcessInspection
  stopTimeoutMs?: number
}): Promise<{ manualInspection: boolean }> {
  const inspection = input.inspection ?? linuxProcessInspection
  let manualInspection = false
  for (const server of input.servers) {
    if (server.child.exitCode !== null || server.child.signalCode !== null)
      continue
    try {
      const identity = await reverifyOwnedServer(server, inspection)
      if (identity.state === "T")
        await thawOwnedServer(server, input.environment, inspection)
      if (
        (await stopOwnedServer(server, inspection, input.stopTimeoutMs)) ===
        null
      )
        manualInspection = true
    } catch {
      manualInspection = true
    }
  }
  // Never signalled: identity was not proven.
  for (const child of input.unverified)
    if (child.child.exitCode === null && child.child.signalCode === null)
      manualInspection = true
  return { manualInspection }
}

export function classifyExit(
  exit: { code: number | null; signal: NodeJS.Signals | null } | null,
): CrashOutcome {
  if (exit === null) return { kind: "INCONCLUSIVE", reason: "EXIT_TIMEOUT" }
  if (exit.signal === "SIGKILL" && exit.code === null)
    return { kind: "CRASHED" }
  return {
    kind: "INCONCLUSIVE",
    reason: exit.signal ? `SIGNAL_${exit.signal}` : "NORMAL_EXIT",
  }
}

// ----------------------------------------------------------------- Verdicts

export type B2Verdict = "PASS" | "FAIL" | "INCONCLUSIVE"

export interface BoundaryObservation {
  frozen: boolean
  /** A: the running preview (H2). */
  aStatus: string | null
  /** HTTP status of A's route through the artifact host just before freezing. */
  aRouteStatus: number | null
  /** A's queue row. While A is ready the single FullStackPreviewWorkerLoop is
   * still inside `worker.run()` (monitorLifecycle), so it stays `leased`. */
  aQueueStatus: string | null
  /** B: admitted after A, waiting before START (H1). */
  bStatus: string | null
  bQueueStatus: string | null
}

/** Each boundary is judged from the frozen durable state. H2 needs A ready,
 * served (200) and holding the only orchestration slot; H1 needs B's parent
 * and queue row both still `queued` (never leased, so START never ran). */
export function classifyBoundary(observation: BoundaryObservation): {
  h1: boolean
  h2: boolean
} {
  return {
    h2:
      observation.frozen &&
      observation.aStatus === "ready" &&
      observation.aRouteStatus === 200 &&
      observation.aQueueStatus === "leased",
    h1:
      observation.frozen &&
      observation.bStatus === "queued" &&
      observation.bQueueStatus === "queued",
  }
}

export interface RestartFacts {
  crash: CrashOutcome
  /** The restarted server's identity was proven and differs from the old one. */
  freshProcess: boolean
}

function restartProblem(facts: RestartFacts): string | null {
  if (facts.crash.kind !== "CRASHED") return `CRASH_${facts.crash.reason}`
  if (!facts.freshProcess) return "NO_FRESH_PROCESS"
  return null
}

export interface H1Facts extends RestartFacts {
  boundaryReached: boolean
  /** Terminal parent status/error after restart, or null if never terminal. */
  bStatus: string | null
  bErrorCode: string | null
  bEverReady: boolean
  /** Any user-environment material appeared under the test root afterwards. */
  userEnvironmentDelivered: boolean | null
}

export function classifyH1(facts: H1Facts): {
  verdict: B2Verdict
  code: string
} {
  if (!facts.boundaryReached)
    return { verdict: "INCONCLUSIVE", code: "BOUNDARY_NOT_REACHED" }
  const problem = restartProblem(facts)
  if (problem) return { verdict: "INCONCLUSIVE", code: problem }
  if (facts.bEverReady || facts.bStatus === "ready")
    return { verdict: "FAIL", code: "RAN_WITHOUT_ADMITTED_VALUES" }
  if (facts.userEnvironmentDelivered === true)
    return { verdict: "FAIL", code: "MATERIAL_DELIVERED" }
  if (facts.userEnvironmentDelivered === null)
    return { verdict: "INCONCLUSIVE", code: "MATERIAL_INVENTORY_UNREADABLE" }
  if (
    facts.bStatus === "failed" &&
    facts.bErrorCode === "CONFIGURATION_UNAVAILABLE"
  )
    return { verdict: "PASS", code: "CONFIGURATION_UNAVAILABLE" }
  // ORCHESTRATION_UNAVAILABLE, FRONTEND_FAILED, timeouts etc. never prove
  // that the consumption boundary was reached; they are not H1 evidence.
  return { verdict: "INCONCLUSIVE", code: "CONSUMPTION_BOUNDARY_NOT_PROVEN" }
}

export const OWNED_RESOURCE_KINDS = [
  "loopDevices",
  "networkLeases",
  "runscContainers",
  "networkNamespaces",
  "hostLinks",
  "firewallRules",
  "generatedSecretFiles",
  "databaseCredentialFiles",
  "userEnvironmentFiles",
  "newMounts",
] as const

export type OwnedResourceCounts = Record<
  (typeof OWNED_RESOURCE_KINDS)[number],
  number | null
>

export interface H2Facts extends RestartFacts {
  boundaryReached: boolean
  /** A's status at the first moment the restarted API answered. */
  aStatusAtFirstResponse: string | null
  aErrorCode: string | null
  aQueueStatus: string | null
  /** A's old route through the restarted artifact host; null = unreachable. */
  aRouteStatusAfter: number | null
  resources: OwnedResourceCounts
  /** Fresh startup reapers re-run after a graceful stop. */
  repeatedReap: { changed: number; failed: boolean } | null
  /** The restarted server refused to listen when recovery was made to fail. */
  listenerGatedOnFailedRecovery: boolean | null
}

export function classifyH2(facts: H2Facts): {
  verdict: B2Verdict
  code: string
} {
  if (!facts.boundaryReached)
    return { verdict: "INCONCLUSIVE", code: "BOUNDARY_NOT_REACHED" }
  const problem = restartProblem(facts)
  if (problem) return { verdict: "INCONCLUSIVE", code: problem }
  if (facts.aStatusAtFirstResponse === "ready")
    return { verdict: "FAIL", code: "STALE_READY_SERVED" }
  if (facts.aRouteStatusAfter === 200)
    return { verdict: "FAIL", code: "STALE_ROUTE_SERVED" }
  if (facts.aQueueStatus === "queued" || facts.aQueueStatus === "leased")
    return { verdict: "FAIL", code: "QUEUE_DELIVERY_RETAINED" }
  const counts = Object.values(facts.resources)
  if (counts.some((count) => count !== null && count > 0))
    return { verdict: "FAIL", code: "OWNED_RESOURCE_REMAINS" }
  if (facts.repeatedReap?.failed || (facts.repeatedReap?.changed ?? 0) > 0)
    return { verdict: "FAIL", code: "REAPER_NOT_IDEMPOTENT" }
  if (facts.listenerGatedOnFailedRecovery === false)
    return { verdict: "FAIL", code: "LISTENER_OPENED_AFTER_FAILED_RECOVERY" }
  if (
    counts.some((count) => count === null) ||
    facts.repeatedReap === null ||
    facts.listenerGatedOnFailedRecovery === null ||
    facts.aRouteStatusAfter === null
  )
    return { verdict: "INCONCLUSIVE", code: "EVIDENCE_INCOMPLETE" }
  if (
    facts.aStatusAtFirstResponse === "failed" &&
    facts.aErrorCode === "ORCHESTRATION_UNAVAILABLE"
  )
    return { verdict: "PASS", code: "RECOVERED" }
  return { verdict: "INCONCLUSIVE", code: "RECONCILIATION_NOT_PROVEN" }
}

// ------------------------------------------------- Operator-supplied inputs

export interface B2Fixture {
  repositoryId: number
  owner: string
  name: string
  commitSha: string
  frontendSourceRoot: string
  backendSourceRoot: string
  /** Exactly the non-sensitive names the server derives for this backend. */
  environmentNames: string[]
}

/** A public fixture repository at an exact commit; values are synthetic. */
export function parseB2Fixture(raw: string | undefined): B2Fixture {
  let value: unknown
  try {
    value = JSON.parse(raw ?? "")
  } catch {
    throw new Error("B2_FIXTURE_INVALID")
  }
  const fixture = value as Partial<B2Fixture> | null
  if (
    !fixture ||
    !Number.isSafeInteger(fixture.repositoryId) ||
    (fixture.repositoryId ?? 0) <= 0 ||
    typeof fixture.owner !== "string" ||
    !/^[A-Za-z\d-]{1,39}$/.test(fixture.owner) ||
    typeof fixture.name !== "string" ||
    !/^[A-Za-z\d._-]{1,100}$/.test(fixture.name) ||
    typeof fixture.commitSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(fixture.commitSha) ||
    typeof fixture.frontendSourceRoot !== "string" ||
    typeof fixture.backendSourceRoot !== "string" ||
    !Array.isArray(fixture.environmentNames) ||
    fixture.environmentNames.length === 0 ||
    !fixture.environmentNames.every(
      (name) => typeof name === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(name),
    )
  )
    throw new Error("B2_FIXTURE_INVALID")
  return fixture as B2Fixture
}

/** Synthetic, non-credential values unique to this run (never logged). */
export function syntheticEnvironment(
  names: readonly string[],
  runTag: string,
): Array<{ name: string; value: string }> {
  return names.map((name, index) => ({
    name,
    value: `b2-synthetic-${runTag}-${String(index)}`,
  }))
}

/** The startup reconciler acts on EVERY durable row, so the B2 database must
 * be a dedicated loopback test database named `peephole_b2_test*`. Remote hosts are refused
 * outright; emptiness is checked separately before the first start.
 * node-postgres lets query parameters (`?host=`, `?port=`, `?sslmode=`, ...)
 * override the URL's own host and port, so ANY query string or fragment --
 * even an empty `?` or `#`, which URL parsing would normalize away -- is
 * refused. Errors never echo the URL or its credentials. */
export function assertDedicatedTestDatabaseUrl(
  raw: string | undefined,
): string {
  if (raw === undefined || raw !== raw.trim() || /[?#]/.test(raw))
    throw new Error("B2_TEST_DATABASE_INVALID")
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("B2_TEST_DATABASE_INVALID")
  }
  if (url.search !== "" || url.hash !== "")
    throw new Error("B2_TEST_DATABASE_INVALID")
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !loopback ||
    !/^peephole_b2_test[a-z0-9_]*$/.test(url.pathname.slice(1))
  )
    throw new Error("B2_TEST_DATABASE_INVALID")
  return raw as string
}

// --------------------------------------------------------- Loopback helpers

/** An ephemeral loopback port that was free at the time of the call. */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("B2_PORT_UNAVAILABLE")),
      )
    })
  })
}

export function loopbackAccepts(
  port: number,
  timeoutMs = 500,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket()
    const finish = (open: boolean) => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once("error", () => finish(false))
    socket.connect(port, "127.0.0.1", () => finish(true))
  })
}

/** Loopback-only HTTP. Returns status and parsed JSON (or null); a
 * connection failure resolves null rather than throwing raw details. */
export function loopbackRequest(input: {
  port: number
  method: "GET" | "POST"
  path: string
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
}): Promise<{ status: number; json: unknown } | null> {
  return new Promise((resolve) => {
    const payload =
      input.body === undefined ? undefined : JSON.stringify(input.body)
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: input.port,
        method: input.method,
        path: input.path,
        headers: {
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(payload)),
              }
            : {}),
          ...input.headers,
        },
        timeout: input.timeoutMs ?? 10_000,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () => {
          let json: unknown
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"))
          } catch {
            json = null
          }
          resolve({ status: response.statusCode ?? 0, json })
        })
        response.on("error", () => resolve(null))
      },
    )
    request.on("timeout", () => request.destroy())
    request.on("error", () => resolve(null))
    if (payload) request.write(payload)
    request.end()
  })
}

// ----------------------------------------------------------------- Evidence

export interface B2Evidence {
  schema: "peephole-b2-server-crash/v1"
  scenario: "H1" | "H2" | "R0"
  verdict: B2Verdict | "NOT_RUN"
  code: string
  sourceSha: string
  stages: string[]
  counts?: Partial<Record<string, number | null>>
}

/** Serializes evidence after proving it contains none of the run's
 * sensitive values (nonce, secrets, database URL, user values, tokens). */
export function formatB2Evidence(
  evidence: B2Evidence,
  forbidden: readonly string[],
): string {
  const serialized = JSON.stringify(evidence)
  for (const value of forbidden)
    if (value && serialized.includes(value))
      throw new Error("B2_EVIDENCE_CONTAINS_SENSITIVE_VALUE")
  if (!/^[0-9a-f]{40}$/.test(evidence.sourceSha))
    throw new Error("B2_EVIDENCE_SOURCE_SHA_INVALID")
  return `[b2-server-crash-evidence] ${serialized}`
}
