import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import path from "node:path/posix"
import type { PoolConfig } from "pg"
import type { QueuedFullStackPreview } from "../../types/fullstackPreview"
import type { FakeFullStackPreviewStore } from "./fakeFullStackPreview"
import type { BackendRuntimeDiagnosticEvent } from "../../services/backend-runtime-api/diagnostics"
import {
  BACKEND_CLEANUP_FAILURE_CODES,
  BACKEND_FAILURE_STAGES,
} from "../../services/backend-runtime-api/diagnostics"
import type { BackendRuntimeErrorCode } from "../../types/backendRuntime"
import {
  findProductionHostMarkers,
  inspectM12TestRootfs,
  m12RealSuiteEnabled,
  pathsOverlap,
  readM12HarnessConfig,
  type M12HarnessConfig,
} from "./m12RealGvisorHarness"

export const COMBINED_GATE = "PEEPHOLE_M12_COMBINED_REAL_TESTS"
export const COMBINED_CODES = [
  "PREFLIGHT_FAILED",
  "HOST_OWNERSHIP_REJECTED",
  "DATABASE_OWNERSHIP_REJECTED",
  "POSTGRES_POLICY_REJECTED",
  "SETUP_FAILED",
  "FULLSTACK_FAILED",
  "READINESS_FAILED",
  "MATERIAL_DELIVERY_FAILED",
  "CONFIG_CHECK_FAILED",
  "DATABASE_QUERY_FAILED",
  "SECRET_CHECK_FAILED",
  "STOP_FAILED",
  "RECLAMATION_FAILED",
  "SCENARIO_FAILED",
] as const
export type CombinedCode = (typeof COMBINED_CODES)[number]
export type StepStatus = "PASS" | "FAIL" | "NOT_RUN"

/** Never carries a raw exception, cause, stack, response or command output. */
export class CombinedHarnessError extends Error {
  readonly code: CombinedCode
  constructor(code: CombinedCode) {
    const safe = COMBINED_CODES.includes(code) ? code : "SCENARIO_FAILED"
    super(safe)
    this.code = safe
    this.name = "CombinedHarnessError"
    this.stack = undefined
  }
}
export function requireCombined(
  condition: unknown,
  code: CombinedCode,
): asserts condition {
  if (!condition) throw new CombinedHarnessError(code)
}
export function combinedSuiteEnabled(
  env: Readonly<Record<string, string | undefined>>,
) {
  return m12RealSuiteEnabled(env) && env[COMBINED_GATE] === "1"
}

export interface CombinedAttestation {
  schema: "peephole-m12-combined/v1"
  dedicatedNonProduction: true
  machineId: string
  bootId: string
  parent: string
  postgresRoot: string
}

export function validateAttestation(
  value: unknown,
  expected: Omit<CombinedAttestation, "schema" | "dedicatedNonProduction">,
): void {
  requireCombined(
    value !== null && typeof value === "object",
    "HOST_OWNERSHIP_REJECTED",
  )
  const v = value as Partial<CombinedAttestation>
  requireCombined(
    v.schema === "peephole-m12-combined/v1" &&
      v.dedicatedNonProduction === true &&
      v.machineId === expected.machineId &&
      v.bootId === expected.bootId &&
      v.parent === expected.parent &&
      v.postgresRoot === expected.postgresRoot,
    "HOST_OWNERSHIP_REJECTED",
  )
}

export interface LocalPostgresFacts {
  pid: number
  socketPid: number
  postgresUid: number
  socketUid: number
  version: string
  dataDir: string
  pidDataDir: string
  processCwd: string
  processExecutable: string
}
export function validateLocalPostgres(facts: LocalPostgresFacts): void {
  requireCombined(
    Number.isSafeInteger(facts.pid) &&
      facts.pid > 1 &&
      facts.pid === facts.socketPid &&
      facts.postgresUid > 0 &&
      facts.socketUid === facts.postgresUid &&
      facts.version === "18" &&
      facts.dataDir === facts.pidDataDir &&
      facts.dataDir === facts.processCwd &&
      path.basename(facts.processExecutable) === "postgres",
    "DATABASE_OWNERSHIP_REJECTED",
  )
}

export function validateCombinedHba(contents: string): void {
  const rules = contents
    .split("\n")
    .map((line) => line.split("#")[0]!.trim().replace(/\s+/g, " "))
    .filter(Boolean)
  const expected = [
    "local all postgres peer",
    "local all m12_combined_provisioner scram-sha-256",
    "host all all 10.200.0.0/16 scram-sha-256",
  ]
  requireCombined(
    rules.length === expected.length &&
      rules.every((line, index) => line === expected[index]),
    "DATABASE_OWNERSHIP_REJECTED",
  )
}

/** Even a failed CREATE ROLE must not log its SCRAM verifier/parameters. */
export function validatePostgresLogging(
  settings: Record<string, unknown>,
): void {
  const expected: Record<string, string> = {
    log_statement: "none",
    log_min_error_statement: "panic",
    log_min_messages: "panic",
    log_duration: "off",
    log_min_duration_statement: "-1",
    log_min_duration_sample: "-1",
    log_transaction_sample_rate: "0",
    log_parameter_max_length: "0",
    log_parameter_max_length_on_error: "0",
  }
  requireCombined(
    Object.entries(expected).every(([name, value]) => settings[name] === value),
    "POSTGRES_POLICY_REJECTED",
  )
}

/** PG18 hides these preload settings from a restricted provisioner.
 * Inspect the positively owned config instead of granting extra SQL roles. */
export function validatePostgresFiles(
  config: string,
  autoConfig: string,
): void {
  const active = (text: string) =>
    text
      .split("\n")
      .map((line) => line.split("#")[0]!.trim())
      .filter(Boolean)
  const lines = active(config)
  requireCombined(
    !lines.some((line) =>
      /^(?:include(?:_if_exists|_dir)?|data_directory|hba_file|config_file)\b/i.test(
        line,
      ),
    ) &&
      ["shared_preload_libraries", "session_preload_libraries"].every(
        (name) => {
          const entries = lines.filter((line) =>
            new RegExp(`^${name}\\b`, "i").test(line),
          )
          return (
            entries.length === 1 &&
            new RegExp(`^${name}\\s*=\\s*''$`, "i").test(entries[0]!)
          )
        },
      ) &&
      active(autoConfig).length === 0,
    "DATABASE_OWNERSHIP_REJECTED",
  )
}

async function canonical(candidate: string): Promise<void> {
  requireCombined(
    candidate.startsWith("/") &&
      path.resolve(candidate) === candidate &&
      (await realpath(candidate)) === candidate,
    "HOST_OWNERSHIP_REJECTED",
  )
}
async function privateFile(file: string): Promise<string> {
  await canonical(file)
  const stats = await lstat(file)
  requireCombined(
    stats.isFile() &&
      !stats.isSymbolicLink() &&
      stats.uid === 0 &&
      (stats.mode & 0o777) === 0o600 &&
      stats.size <= 16_384,
    "HOST_OWNERSHIP_REJECTED",
  )
  return readFile(file, "utf8")
}

/** Read-only, before constructing any PG pool or allocating any test resource.
 * Explicit positive operator attestation is required IN ADDITION to the older
 * harness's negative production-marker and canonical-path checks. No URL/env
 * credential fallback. PoolConfig is process-local and must never be logged. */
export async function preflightCombinedHost(
  env: Readonly<Record<string, string | undefined>>,
  bootstrap: Buffer,
): Promise<{
  config: M12HarnessConfig
  parent: string
  postgres: PoolConfig
}> {
  try {
    requireCombined(
      combinedSuiteEnabled(env) &&
        process.platform === "linux" &&
        process.getuid?.() === 0,
      "PREFLIGHT_FAILED",
    )
    requireCombined(
      ![
        "PGOPTIONS",
        "PGSERVICE",
        "PGSERVICEFILE",
        "PEEPHOLE_DATABASE_URL",
        "PEEPHOLE_TENANT_DB_PROVISIONING_URL",
        "PEEPHOLE_GITHUB_TOKEN",
        "PEEPHOLE_GITHUB_GATEWAY_TOKEN",
      ].some((key) => env[key] !== undefined),
      "HOST_OWNERSHIP_REJECTED",
    )
    const config = await readM12HarnessConfig(env)
    const parent = path.dirname(config.workspaceRoot)
    const parentStats = await lstat(parent)
    requireCombined(
      parentStats.isDirectory() &&
        parentStats.uid === 0 &&
        (parentStats.mode & 0o777) === 0o700,
      "HOST_OWNERSHIP_REJECTED",
    )
    for (const root of [
      config.workspaceRoot,
      config.runscRoot,
      config.tmpfsRoot,
    ]) {
      requireCombined(
        (await readdir(root)).length === 0,
        "HOST_OWNERSHIP_REJECTED",
      )
    }
    requireCombined(
      config.workspaceRoot === `${parent}/workspace` &&
        config.runscRoot === `${parent}/runsc` &&
        config.tmpfsRoot === `${parent}/tmpfs` &&
        config.baseRootfs === `${parent}/rootfs`,
      "HOST_OWNERSHIP_REJECTED",
    )
    const root = env.PEEPHOLE_M12_COMBINED_POSTGRES_ROOT ?? ""
    requireCombined(
      /^\/srv\/peephole-m12-db-[a-zA-Z0-9-]+$/.test(root) &&
        !pathsOverlap(parent, root),
      "DATABASE_OWNERSHIP_REJECTED",
    )
    await canonical(root)
    const rootStat = await lstat(root)
    requireCombined(
      rootStat.isDirectory() &&
        rootStat.uid === 0 &&
        (rootStat.mode & 0o777) === 0o711,
      "DATABASE_OWNERSHIP_REJECTED",
    )
    const parentMarker = (
      await privateFile(`${parent}/.peephole-m12-test-parent`)
    ).split("\n")
    requireCombined(
      parentMarker[0] === "peephole-m12-test-parent/v1" &&
        /^[a-f0-9]{32}$/.test(parentMarker[1] ?? "") &&
        parentMarker[2] === parent,
      "HOST_OWNERSHIP_REJECTED",
    )
    const machineId = (await readFile("/etc/machine-id", "utf8")).trim()
    const bootId = (
      await readFile("/proc/sys/kernel/random/boot_id", "utf8")
    ).trim()
    requireCombined(
      /^[a-f0-9]{32}$/.test(machineId) && /^[a-f0-9-]{36}$/.test(bootId),
      "HOST_OWNERSHIP_REJECTED",
    )
    const expected = { parent, postgresRoot: root, machineId, bootId }
    validateAttestation(
      JSON.parse(await privateFile(`${parent}/.peephole-m12-combined.json`)),
      expected,
    )
    validateAttestation(
      JSON.parse(await privateFile(`${root}/.peephole-m12-combined.json`)),
      expected,
    )
    requireCombined(
      (await findProductionHostMarkers()).length === 0 &&
        (await inspectM12TestRootfs(config.baseRootfs, bootstrap)).length === 0,
      "HOST_OWNERSHIP_REJECTED",
    )
    const dataDir = `${root}/data`
    const socketDir = `${root}/socket`
    await canonical(dataDir)
    await canonical(socketDir)
    const dataStats = await lstat(dataDir)
    await canonical(`${socketDir}/.s.PGSQL.5433`)
    const socketStats = await lstat(`${socketDir}/.s.PGSQL.5433`)
    requireCombined(
      dataStats.isDirectory() && socketStats.isSocket(),
      "DATABASE_OWNERSHIP_REJECTED",
    )
    const pidLines = (
      await readFile(`${dataDir}/postmaster.pid`, "utf8")
    ).split("\n")
    const pid = Number(pidLines[0])
    requireCombined(
      Number.isSafeInteger(pid) && pid > 1,
      "DATABASE_OWNERSHIP_REJECTED",
    )
    const socketPid = Number(
      (await readFile(`${socketDir}/.s.PGSQL.5433.lock`, "utf8")).split(
        "\n",
      )[0],
    )
    validateLocalPostgres({
      pid,
      socketPid,
      postgresUid: dataStats.uid,
      socketUid: socketStats.uid,
      version: (await readFile(`${dataDir}/PG_VERSION`, "utf8")).trim(),
      dataDir,
      pidDataDir: pidLines[1] ?? "",
      processCwd: await realpath(`/proc/${pid}/cwd`),
      processExecutable: await realpath(`/proc/${pid}/exe`),
    })
    // The positively identified disposable postmaster must use its own
    // default config/HBA, not an alternative cluster's files or overrides.
    const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8"))
      .split("\0")
      .filter(Boolean)
    requireCombined(
      argv.length === 3 &&
        path.basename(argv[0]!) === "postgres" &&
        argv[1] === "-D" &&
        argv[2] === dataDir,
      "DATABASE_OWNERSHIP_REJECTED",
    )
    for (const file of [
      "postgresql.conf",
      "postgresql.auto.conf",
      "pg_hba.conf",
    ])
      await canonical(`${dataDir}/${file}`)
    validatePostgresFiles(
      await readFile(`${dataDir}/postgresql.conf`, "utf8"),
      await readFile(`${dataDir}/postgresql.auto.conf`, "utf8"),
    )
    validateCombinedHba(await readFile(`${dataDir}/pg_hba.conf`, "utf8"))
    const credential = JSON.parse(
      await privateFile(`${root}/provisioner.json`),
    ) as Record<string, unknown>
    requireCombined(
      credential.user === "m12_combined_provisioner" &&
        credential.database === "postgres" &&
        typeof credential.password === "string" &&
        credential.password.length > 0,
      "DATABASE_OWNERSHIP_REJECTED",
    )
    return {
      config,
      parent,
      postgres: {
        host: socketDir,
        port: 5433,
        user: credential.user,
        password: credential.password,
        database: credential.database,
        max: 2,
        ssl: false,
        connectionTimeoutMillis: 5_000,
        query_timeout: 10_000,
        statement_timeout: 10_000,
      },
    }
  } catch (error) {
    throw error instanceof CombinedHarnessError
      ? error
      : new CombinedHarnessError("PREFLIGHT_FAILED")
  }
}

const primaryCodes: Record<BackendRuntimeErrorCode, true> = {
  FETCH_FAILED: true,
  UNSUPPORTED_BACKEND: true,
  INSTALL_FAILED: true,
  SECRET_UNAVAILABLE: true,
  DATABASE_UNAVAILABLE: true,
  CONFIGURATION_UNAVAILABLE: true,
  RUNTIME_START_FAILED: true,
  RUNTIME_READINESS_TIMEOUT: true,
  RUNTIME_EXITED: true,
  RUNTIME_TIMEOUT: true,
  RUNTIME_DISK_LIMIT: true,
  RUNTIME_UNAVAILABLE: true,
}
/** Project only validated D1 fields; never serialize a caller's object. */
export function safeDiagnostic(event: BackendRuntimeDiagnosticEvent | null) {
  if (!event) return null
  requireCombined(
    typeof event.runtimeId === "string" &&
      /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(event.runtimeId) &&
      (event.failureStage === null ||
        BACKEND_FAILURE_STAGES.includes(event.failureStage)) &&
      (event.primaryFailureCode === null ||
        (typeof event.primaryFailureCode === "string" &&
          Object.hasOwn(primaryCodes, event.primaryFailureCode))) &&
      BACKEND_CLEANUP_FAILURE_CODES.includes(event.cleanupFailureCode),
    "SCENARIO_FAILED",
  )
  return {
    runtimeId: event.runtimeId,
    failureStage: event.failureStage,
    primaryFailureCode: event.primaryFailureCode,
    cleanupFailureCode: event.cleanupFailureCode,
  }
}

/** No force cleanup/reaper fallback: the next action is always attempted,
 * but an unsuccessful proof preserves owned directories for manual review. */
export async function attemptCombinedCleanup(
  actions: readonly (() => Promise<void>)[],
): Promise<boolean> {
  let clean = true
  for (const action of actions) {
    try {
      await action()
    } catch {
      clean = false
    }
  }
  return clean
}

/** FakeFullStackPreviewStore models atomic row+queue insertion, so its
 * separate FakeFullStackPreviewQueue is intentionally not enqueued. Read
 * the actual test-store queue identity and derive its authoritative payload. */
export async function takeCombinedParent(
  store: FakeFullStackPreviewStore,
  id: string,
): Promise<QueuedFullStackPreview> {
  const parent = await store.get(id)
  requireCombined(
    store.queuedPreviewIds[0] === id && parent?.status === "queued",
    "FULLSTACK_FAILED",
  )
  store.queuedPreviewIds.shift()
  return {
    previewId: parent.id,
    repository: structuredClone(parent.repository),
    frontendSourceRoot: parent.frontendSourceRoot,
    backendSourceRoot: parent.backendSourceRoot,
  }
}
