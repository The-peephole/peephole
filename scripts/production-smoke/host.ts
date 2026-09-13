import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

import type { QueryResultRow } from "pg"

import { MAX_CAPTURED_LOG_BYTES } from "../../core/runner/runnerLimits"
import { PgPoolDatabase } from "../../services/preview-api/postgres/database"
import type { PostgresDatabase } from "../../services/preview-api/postgres/database"
import { readPostgresConfig } from "../../services/preview-api/postgres/config"
import { readPreviewApiServerConfig } from "../../services/preview-api/serverConfig"
import { NodeProcessRunner } from "../../services/preview-worker/gvisor/nodeProcessRunner"
import type {
  ProcessRunner,
  ProcessRunResult,
} from "../../services/preview-worker/gvisor/processRunner"
import { readProductionConfig } from "../../services/production/config"
import {
  ProductionSmokeError,
  type SmokeReporter,
  verifyServiceEndpoints,
} from "./api"

const NETWORK_LEASE_ROOT = "/var/run/peephole/net-leases"
const COMMAND_TIMEOUT_MS = 10_000
const MAX_MOUNTINFO_BYTES = 4 * 1024 * 1024
const SERVICE_ERROR_PATTERN =
  "worker loop error|cleanup failed; will retry|production server failed to start|Container cleanup failed|network cleanup failed"

const BUNDLE_PATTERNS = [
  /^peephole-[a-f\d]{32}$/,
  /^\.peephole-allocating-[a-f\d]{32}-[a-f\d]{32}$/,
  /^\.peephole-disk-allocation\.lock$/,
  /^\.peephole-disk-lock-stale-[a-f\d]{16}$/,
]
const NETWORK_LEASE_PATTERNS = [
  /^(0|[1-9]\d{0,4})$/,
  /^\.peephole-net-allocating-(0|[1-9]\d{0,4})-[a-f\d]{32}$/,
  /^\.peephole-net-releasing-(0|[1-9]\d{0,4})-[a-f\d]{32}$/,
  /^\.peephole-network-allocation\.lock$/,
  /^\.peephole-network-lock-allocating-[a-f\d]{32}$/,
  /^\.peephole-network-lock-releasing-[a-f\d]{32}$/,
]

export interface HostSmokeConfig {
  localApiBaseUrl: string
  bundlesRootDir: string
  runscRootDir: string
  networkLeaseDir: string
  pollIntervalMs: number
  pollTimeoutMs: number
  requestTimeoutMs: number
  journalSince: string
}

export interface HostMount {
  target: string
  source: string
  fstype: string
}

export interface HostLoopDevice {
  name: string
  backingFile: string
}

export interface HostResidueSnapshot {
  runscContainers: string[]
  bundleEntries: string[]
  networkLeaseEntries: string[]
  namespaces: string[]
  links: string[]
  ipv4Rules: string[]
  natRules: string[]
  ipv6Rules: string[]
  mounts: HostMount[]
  loopDevices: HostLoopDevice[]
}

export interface HostResidueReport {
  runsc: string[]
  networkLeases: string[]
  namespacesAndVeths: string[]
  firewall: string[]
  mountsAndLoops: string[]
  bundles: string[]
}

export interface HostSmokeDependencies {
  fetch?: typeof globalThis.fetch
  runner?: ProcessRunner
  database?: PostgresDatabase
  readMountInfo?: () => Promise<Buffer>
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  report?: SmokeReporter
  platform?: NodeJS.Platform
  uid?: number
}

interface CountRow extends QueryResultRow {
  count: string
}

interface DatabaseCounts {
  activeJobs: number
  queueRows: number
}

export function readHostSmokeConfig(
  environment: NodeJS.ProcessEnv,
): HostSmokeConfig {
  const production = readProductionConfig(environment)
  const api = readPreviewApiServerConfig(environment)
  const networkLeaseDir =
    environment.PEEPHOLE_SMOKE_NETWORK_LEASE_DIR?.trim() || NETWORK_LEASE_ROOT
  const requiredPaths = [
    ["PEEPHOLE_GVISOR_BUNDLES_DIR", production.bundlesRootDir],
    ["PEEPHOLE_GVISOR_RUNSC_ROOT", production.runscRootDir],
    ["PEEPHOLE_SMOKE_NETWORK_LEASE_DIR", networkLeaseDir],
  ] as const
  const invalidPath = requiredPaths.find(
    ([, value]) => !path.posix.isAbsolute(value.replaceAll("\\", "/")),
  )
  if (invalidPath) {
    throw new ProductionSmokeError(
      "configuration",
      `${invalidPath[0]} must be an absolute Linux path.`,
    )
  }
  const journalSince =
    environment.PEEPHOLE_SMOKE_LOG_SINCE?.trim() || "15 minutes ago"
  if (!/^[\x20-\x7e]{1,80}$/.test(journalSince)) {
    throw new ProductionSmokeError(
      "configuration",
      "PEEPHOLE_SMOKE_LOG_SINCE contains unsupported characters.",
    )
  }

  return {
    localApiBaseUrl: `http://127.0.0.1:${String(api.port)}/`,
    bundlesRootDir: production.bundlesRootDir,
    runscRootDir: production.runscRootDir,
    networkLeaseDir,
    pollIntervalMs: readInteger(
      "PEEPHOLE_SMOKE_HOST_POLL_INTERVAL_MS",
      environment.PEEPHOLE_SMOKE_HOST_POLL_INTERVAL_MS,
      2_000,
      250,
      10_000,
    ),
    pollTimeoutMs: readInteger(
      "PEEPHOLE_SMOKE_HOST_TIMEOUT_MS",
      environment.PEEPHOLE_SMOKE_HOST_TIMEOUT_MS,
      60_000,
      5_000,
      5 * 60_000,
    ),
    requestTimeoutMs: readInteger(
      "PEEPHOLE_SMOKE_REQUEST_TIMEOUT_MS",
      environment.PEEPHOLE_SMOKE_REQUEST_TIMEOUT_MS,
      15_000,
      1_000,
      60_000,
    ),
    journalSince,
  }
}

export async function runProductionHostSmoke(
  config: HostSmokeConfig,
  dependencies: HostSmokeDependencies = {},
): Promise<void> {
  const platform = dependencies.platform ?? process.platform
  const uid = dependencies.uid ?? process.getuid?.()
  if (platform !== "linux") {
    throw new ProductionSmokeError(
      "host preflight",
      "Host residue verification is Linux-only.",
    )
  }
  if (uid !== 0) {
    throw new ProductionSmokeError(
      "host preflight",
      "Host residue verification requires root read access; the script never invokes sudo itself.",
    )
  }

  const runner = dependencies.runner ?? new NodeProcessRunner()
  const fetch = dependencies.fetch ?? globalThis.fetch
  const report = dependencies.report ?? (() => undefined)
  const now = dependencies.now ?? Date.now
  const sleep = dependencies.sleep ?? delay

  await assertServiceActive(runner, "peephole")
  report("Peephole service", "active")
  await assertServiceActive(runner, "caddy")
  report("Caddy service", "active")
  await verifyServiceEndpoints(
    config.localApiBaseUrl,
    fetch,
    config.requestTimeoutMs,
    "local",
    report,
  )

  const ownsDatabase = !dependencies.database
  let database: PostgresDatabase
  try {
    database =
      dependencies.database ??
      new PgPoolDatabase(readPostgresConfig(process.env).pool)
  } catch {
    throw new ProductionSmokeError(
      "database",
      "The host verifier could not initialize its database connection.",
    )
  }

  try {
    const deadline = now() + config.pollTimeoutMs
    let lastCounts: DatabaseCounts = { activeJobs: -1, queueRows: -1 }
    let lastResidue = emptyResidueReport()

    for (;;) {
      lastCounts = await readDatabaseCounts(database)
      const snapshot = await collectHostResidueSnapshot(config, runner, {
        readMountInfo:
          dependencies.readMountInfo ??
          (() => readFile("/proc/self/mountinfo")),
      })
      lastResidue = findHostResidue(snapshot, config.bundlesRootDir)

      if (
        lastCounts.activeJobs === 0 &&
        lastCounts.queueRows === 0 &&
        isResidueEmpty(lastResidue)
      ) {
        report("active jobs", "0")
        report("queue rows", "0")
        report("runsc residue", "0")
        report("network lease residue", "0")
        report("netns/veth residue", "0")
        report("firewall residue", "0")
        report("mount/loop residue", "0")
        report("job bundle residue", "0")
        break
      }

      const remaining = deadline - now()
      if (remaining <= 0) {
        throw new ProductionSmokeError(
          "post-run cleanup",
          describeOutstanding(lastCounts, lastResidue),
        )
      }
      await sleep(Math.min(config.pollIntervalMs, remaining))
    }

    const journal = await runReadOnlyCommand(runner, "journalctl", [
      "--unit",
      "peephole",
      "--since",
      config.journalSince,
      "--no-pager",
      "--output",
      "cat",
      "--grep",
      SERVICE_ERROR_PATTERN,
    ])
    const errorCount = journal.stdout
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0).length
    if (errorCount > 0) {
      throw new ProductionSmokeError(
        "service errors",
        `${String(errorCount)} known worker or cleanup error log line(s) were found since ${config.journalSince}.`,
      )
    }
    report("service errors", `0 since ${config.journalSince}`)
  } finally {
    if (ownsDatabase) await database.close().catch(() => undefined)
  }
}

export async function collectHostResidueSnapshot(
  config: HostSmokeConfig,
  runner: ProcessRunner,
  options: { readMountInfo: () => Promise<Buffer> },
): Promise<HostResidueSnapshot> {
  const runsc = await runReadOnlyCommand(runner, "runsc", [
    "--root",
    config.runscRootDir,
    "list",
    "--format",
    "json",
  ])
  const namespaces = await runReadOnlyCommand(runner, "ip", ["netns", "list"])
  const links = await runReadOnlyCommand(runner, "ip", ["-o", "link", "show"])
  const ipv4 = await runReadOnlyCommand(runner, "iptables", ["-w", "5", "-S"])
  const nat = await runReadOnlyCommand(runner, "iptables", [
    "-w",
    "5",
    "-t",
    "nat",
    "-S",
  ])
  const ipv6 = await runReadOnlyCommand(runner, "ip6tables", ["-w", "5", "-S"])
  const loops = await runReadOnlyCommand(runner, "losetup", [
    "--json",
    "--output",
    "NAME,BACK-FILE",
  ])

  let mountInfo: Buffer
  try {
    mountInfo = await options.readMountInfo()
  } catch {
    throw new ProductionSmokeError(
      "mount inspection",
      "Could not read /proc/self/mountinfo.",
    )
  }
  if (mountInfo.byteLength > MAX_MOUNTINFO_BYTES) {
    throw new ProductionSmokeError(
      "mount inspection",
      "Host mount information exceeded its bounded input limit.",
    )
  }

  const parsedLinks = parseLinks(links.stdout)
  const ipv4Rules = nonEmptyLines(ipv4.stdout)
  const natRules = nonEmptyLines(nat.stdout)
  const ipv6Rules = nonEmptyLines(ipv6.stdout)
  const mounts = parseMountInfo(mountInfo.toString("utf8"))
  if (
    parsedLinks.length === 0 ||
    ipv4Rules.length === 0 ||
    natRules.length === 0 ||
    ipv6Rules.length === 0 ||
    mounts.length === 0
  ) {
    throw new ProductionSmokeError(
      "host inspection",
      "A required host inventory returned an unexpectedly empty baseline.",
    )
  }

  return {
    runscContainers: parseRunscContainers(runsc.stdout),
    bundleEntries: await readDirectoryNames(
      config.bundlesRootDir,
      "job bundles",
    ),
    networkLeaseEntries: await readDirectoryNames(
      config.networkLeaseDir,
      "network leases",
    ),
    namespaces: parseNamespaces(namespaces.stdout),
    links: parsedLinks,
    ipv4Rules,
    natRules,
    ipv6Rules,
    mounts,
    loopDevices: parseLoopDevices(loops.stdout),
  }
}

export function findHostResidue(
  snapshot: HostResidueSnapshot,
  bundlesRootDir: string,
): HostResidueReport {
  const root = normalizeLinuxPath(bundlesRootDir)
  const firewallPattern = /(?:^|\s)(?:pp[rei]\d+|v[ep]ph\d+)(?:\s|$)|peephole-/

  return {
    runsc: [...snapshot.runscContainers],
    networkLeases: snapshot.networkLeaseEntries.filter((entry) =>
      NETWORK_LEASE_PATTERNS.some((pattern) => pattern.test(entry)),
    ),
    namespacesAndVeths: [
      ...snapshot.namespaces.filter((name) => /^peephole-\d+$/.test(name)),
      ...snapshot.links.filter((name) => /^v[ep]ph\d+$/.test(name)),
    ],
    firewall: [
      ...snapshot.ipv4Rules,
      ...snapshot.natRules,
      ...snapshot.ipv6Rules,
    ].filter((rule) => firewallPattern.test(rule)),
    mountsAndLoops: [
      ...snapshot.mounts
        .filter(
          (mount) =>
            isWorkspaceMount(mount.target, root) ||
            isWorkspaceImage(mount.source, root),
        )
        .map((mount) => `${mount.target} <- ${mount.source} (${mount.fstype})`),
      ...snapshot.loopDevices
        .filter((loop) => isWorkspaceImage(loop.backingFile, root))
        .map((loop) => `${loop.name} <- ${loop.backingFile}`),
    ],
    bundles: snapshot.bundleEntries.filter((entry) =>
      BUNDLE_PATTERNS.some((pattern) => pattern.test(entry)),
    ),
  }
}

export function assertNoHostResidue(report: HostResidueReport): void {
  if (!isResidueEmpty(report)) {
    throw new ProductionSmokeError(
      "post-run cleanup",
      describeOutstanding({ activeJobs: 0, queueRows: 0 }, report),
    )
  }
}

function isResidueEmpty(report: HostResidueReport): boolean {
  return Object.values(report).every((entries) => entries.length === 0)
}

function emptyResidueReport(): HostResidueReport {
  return {
    runsc: [],
    networkLeases: [],
    namespacesAndVeths: [],
    firewall: [],
    mountsAndLoops: [],
    bundles: [],
  }
}

async function assertServiceActive(
  runner: ProcessRunner,
  service: string,
): Promise<void> {
  let result: ProcessRunResult
  try {
    result = await runner.run("systemctl", ["is-active", service], {
      timeoutMs: COMMAND_TIMEOUT_MS,
    })
  } catch {
    throw new ProductionSmokeError(
      `${service} service`,
      `Could not inspect ${service}.`,
    )
  }
  if (
    result.timedOut ||
    result.exitCode !== 0 ||
    result.stdout.trim() !== "active"
  ) {
    throw new ProductionSmokeError(
      `${service} service`,
      `${service} is not active.`,
    )
  }
}

async function readDatabaseCounts(
  database: PostgresDatabase,
): Promise<DatabaseCounts> {
  try {
    return await database.transaction(async (client) => {
      await client.query("SET TRANSACTION READ ONLY")
      const active = await client.query<CountRow>(
        `
          SELECT count(*)::text AS count
          FROM peephole_preview_jobs
          WHERE status IN ('queued', 'fetching', 'installing', 'building', 'publishing')
        `,
      )
      const queue = await client.query<CountRow>(
        "SELECT count(*)::text AS count FROM peephole_preview_queue",
      )
      return {
        activeJobs: parseCount(active.rows[0]?.count, "active jobs"),
        queueRows: parseCount(queue.rows[0]?.count, "queue rows"),
      }
    })
  } catch (error) {
    if (error instanceof ProductionSmokeError) throw error
    throw new ProductionSmokeError(
      "database",
      "Read-only production residue queries failed.",
    )
  }
}

function parseCount(value: string | undefined, label: string): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new ProductionSmokeError(
      "database",
      `The ${label} query returned an invalid count.`,
    )
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new ProductionSmokeError(
      "database",
      `The ${label} count exceeded the safe integer range.`,
    )
  }
  return parsed
}

async function runReadOnlyCommand(
  runner: ProcessRunner,
  command: string,
  args: string[],
): Promise<ProcessRunResult> {
  let result: ProcessRunResult
  try {
    result = await runner.run(command, args, { timeoutMs: COMMAND_TIMEOUT_MS })
  } catch {
    throw new ProductionSmokeError(
      "host inspection",
      `Could not execute read-only command ${command}.`,
    )
  }
  if (result.timedOut || result.exitCode !== 0) {
    throw new ProductionSmokeError(
      "host inspection",
      `Read-only command ${command} failed or timed out.`,
    )
  }
  if (
    Buffer.byteLength(result.stdout) >= MAX_CAPTURED_LOG_BYTES ||
    Buffer.byteLength(result.stderr) >= MAX_CAPTURED_LOG_BYTES
  ) {
    throw new ProductionSmokeError(
      "host inspection",
      `Read-only command ${command} reached the captured-output limit.`,
    )
  }
  return result
}

async function readDirectoryNames(
  directory: string,
  label: string,
): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    if (entries.length > 10_000) {
      throw new ProductionSmokeError(
        "host inspection",
        `The configured ${label} root exceeded its entry limit.`,
      )
    }
    return entries.map((entry) => entry.name)
  } catch (error) {
    if (error instanceof ProductionSmokeError) throw error
    throw new ProductionSmokeError(
      "host inspection",
      `Could not inspect the configured ${label} root.`,
    )
  }
}

function parseRunscContainers(stdout: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout) as unknown
  } catch {
    throw new ProductionSmokeError(
      "runsc residue",
      "runsc list returned malformed JSON.",
    )
  }
  if (parsed === null) return []
  if (!Array.isArray(parsed)) {
    throw new ProductionSmokeError(
      "runsc residue",
      "runsc list did not return an array or null.",
    )
  }
  return parsed.map((entry) => {
    if (
      !isObject(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.bundle !== "string"
    ) {
      throw new ProductionSmokeError(
        "runsc residue",
        "runsc list returned an invalid container record.",
      )
    }
    return `${entry.id}@${entry.bundle}`
  })
}

function parseLoopDevices(stdout: string): HostLoopDevice[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout) as unknown
  } catch {
    throw new ProductionSmokeError(
      "loop residue",
      "losetup returned malformed JSON.",
    )
  }
  if (!isObject(parsed) || !Array.isArray(parsed.loopdevices)) {
    throw new ProductionSmokeError(
      "loop residue",
      "losetup returned an invalid result.",
    )
  }
  return parsed.loopdevices.map((entry: unknown) => {
    if (
      !isObject(entry) ||
      typeof entry.name !== "string" ||
      typeof entry["back-file"] !== "string"
    ) {
      throw new ProductionSmokeError(
        "loop residue",
        "losetup returned an invalid loop record.",
      )
    }
    return { name: entry.name, backingFile: entry["back-file"] }
  })
}

function parseNamespaces(stdout: string): string[] {
  return nonEmptyLines(stdout).map((line) => line.trim().split(/\s+/u)[0]!)
}

function parseLinks(stdout: string): string[] {
  return nonEmptyLines(stdout).map((line) => {
    const name = /^\d+:\s+([^:@]+)(?:@[^:]+)?:/u.exec(line)?.[1]
    if (!name) {
      throw new ProductionSmokeError(
        "network residue",
        "ip link returned an unrecognized record.",
      )
    }
    return name
  })
}

function parseMountInfo(stdout: string): HostMount[] {
  return nonEmptyLines(stdout).map((line) => {
    const halves = line.split(" - ")
    const left = halves[0]?.split(" ")
    const right = halves[1]?.split(" ")
    if (halves.length !== 2 || !left?.[4] || !right?.[0] || !right[1]) {
      throw new ProductionSmokeError(
        "mount inspection",
        "/proc/self/mountinfo contained an unrecognized record.",
      )
    }
    return {
      target: decodeMountPath(left[4]),
      source: decodeMountPath(right[1]),
      fstype: right[0],
    }
  })
}

function decodeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  )
}

function isWorkspaceMount(candidate: string, root: string): boolean {
  const relative = path.posix.relative(root, normalizeLinuxPath(candidate))
  return /^peephole-[a-f\d]{32}\/workspace(?:\/| \(deleted\)|$)/.test(relative)
}

function isWorkspaceImage(candidate: string, root: string): boolean {
  const relative = path.posix.relative(root, normalizeLinuxPath(candidate))
  return /^peephole-[a-f\d]{32}\/workspace\.img(?: \(deleted\))?$/.test(
    relative,
  )
}

function normalizeLinuxPath(candidate: string): string {
  return path.posix.resolve(candidate.replaceAll("\\", "/"))
}

function describeOutstanding(
  counts: DatabaseCounts,
  residue: HostResidueReport,
): string {
  const details = [
    ...(counts.activeJobs > 0
      ? [`active jobs=${String(counts.activeJobs)}`]
      : []),
    ...(counts.queueRows > 0 ? [`queue rows=${String(counts.queueRows)}`] : []),
    ...Object.entries(residue).flatMap(([kind, entries]) =>
      entries.map((entry: string) => `${kind}=${entry}`),
    ),
  ]
  const shown = details.slice(0, 20)
  const suffix =
    details.length > shown.length
      ? `; +${String(details.length - shown.length)} more`
      : ""
  return `Cleanup did not become empty: ${shown.join("; ")}${suffix}`
}

function nonEmptyLines(stdout: string): string[] {
  return stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0)
}

function readInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!value) return fallback
  if (!/^\d+$/.test(value)) {
    throw new ProductionSmokeError(
      "configuration",
      `${name} must be an integer.`,
    )
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ProductionSmokeError(
      "configuration",
      `${name} must be between ${String(minimum)} and ${String(maximum)}.`,
    )
  }
  return parsed
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
