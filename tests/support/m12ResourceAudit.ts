/** Live owned-resource audit for the R5-2 journal controller (test-only).
 *
 * `LogNamespace=` runs the unit in its own mount namespace whose mounts do not
 * propagate to the host, and stopping the unit kills its cgroup and drops that
 * namespace. A host check after the unit exits can therefore see a "clean"
 * state that only systemd teardown produced. This audit runs inside the still
 * running unit, after the Vitest child exits, and compares against a snapshot
 * taken before the child. It never deletes anything and never emits a command
 * line, environment value, mount source or command output: only statuses. */
import {
  combineScanStatuses,
  mountsWithin,
  type ScanStatus,
} from "./m12RealGvisorHarness"

export interface ResourceAuditResult {
  mounts: ScanStatus
  processes: ScanStatus
  network: ScanStatus
}

export interface ResourceSnapshot {
  /** Sorted mount points at or below the test roots, strictly below netns dirs. */
  mounts: string[]
  /** `<pid>:<start time>` of the controller and its pre-existing direct
   * children (for example tsx's esbuild service) in the unit cgroup tree. */
  processes: string[]
}

export interface ResourceAuditOperations {
  readFile(candidate: string): Promise<string>
  /** Directory entries with their kind; ENOENT must reject with code ENOENT. */
  readdir(
    candidate: string,
  ): Promise<Array<{ name: string; directory: boolean }>>
  readlink(candidate: string): Promise<string>
  /** Bounded command; rejects on nonzero exit, stderr, timeout or overflow. */
  command(binary: string, args: string[]): Promise<string>
}

export interface ResourceAuditScope {
  /** The four explicit, already validated M12 test roots. */
  roots: readonly string[]
  /** Exact transient unit, e.g. `peephole-m12-<run id>.service`. */
  unit: string
  /** The controller PID. Only it and its direct children that already
   * existed at the baseline may remain in the unit's cgroup tree. */
  pid: number
}

// The harness's own naming (deriveNetworkNames): netns `peephole-<n>`, host/peer
// veth `veph<n>`/`vpph<n>`, chains `pp[eir]<n>`, comments `peephole-<id>-<n>`.
// Lease files are deleted with the run directories, so ownership is proven by
// requiring zero Peephole-shaped network state before the child runs.
const NETNS_NAME = /^peephole-[0-9]+$/
const LINK_NAME = /^(veph|vpph)[0-9]+$/
const IPTABLES_TOKEN = /(^|[\s:])pp[eir][0-9]+(\s|$)|peephole-/
export const NETNS_DIRECTORIES = ["/run/netns", "/var/run/netns"] as const
const MAX_CGROUPS = 256
const MAX_CGROUP_DEPTH = 16
const MAX_PROCESSES = 65_536

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "ENOENT" || code === "ESRCH"
}

async function guarded(check: () => Promise<ScanStatus>): Promise<ScanStatus> {
  try {
    return await check()
  } catch {
    return "INCOMPLETE"
  }
}

async function relevantMounts(
  scope: ResourceAuditScope,
  operations: ResourceAuditOperations,
): Promise<string[]> {
  const mountInfo = await operations.readFile("/proc/self/mountinfo")
  if (!mountInfo.trim()) throw new Error("RESOURCE_AUDIT_MOUNTINFO_EMPTY")
  const mounts = scope.roots.flatMap((root) => mountsWithin(root, mountInfo))
  // `ip netns add` may leave the netns directory's own self-bind mount; only a
  // namespace bind strictly below it is an owned resource.
  for (const directory of NETNS_DIRECTORIES)
    mounts.push(
      ...mountsWithin(directory, mountInfo).filter((m) => m !== directory),
    )
  return mounts.sort()
}

async function netnsNames(
  operations: ResourceAuditOperations,
): Promise<string[]> {
  const names: string[] = []
  for (const directory of NETNS_DIRECTORIES) {
    try {
      for (const entry of await operations.readdir(directory))
        if (NETNS_NAME.test(entry.name)) names.push(entry.name)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  return names
}

/** Link/iptables inventories are meaningful only in the host network
 * namespace; the unit must not have its own (no PrivateNetwork=). */
async function assertHostNetworkNamespace(
  operations: ResourceAuditOperations,
): Promise<void> {
  const own = await operations.readlink("/proc/self/ns/net")
  const init = await operations.readlink("/proc/1/ns/net")
  if (!/^net:\[[0-9]+\]$/.test(own) || own !== init)
    throw new Error("RESOURCE_AUDIT_NOT_HOST_NETNS")
}

async function peepholeLinks(
  operations: ResourceAuditOperations,
): Promise<number> {
  const parsed: unknown = JSON.parse(
    await operations.command("ip", ["-j", "link", "show"]),
  )
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new Error("RESOURCE_AUDIT_LINKS_INVALID")
  let count = 0
  for (const link of parsed) {
    const name = (link as { ifname?: unknown } | null)?.ifname
    if (typeof name !== "string") throw new Error("RESOURCE_AUDIT_LINK_INVALID")
    if (LINK_NAME.test(name)) count += 1
  }
  return count
}

async function peepholeRules(
  operations: ResourceAuditOperations,
): Promise<number> {
  let count = 0
  for (const binary of ["iptables-save", "ip6tables-save"]) {
    const output = await operations.command(binary, [])
    if (!output.includes("COMMIT"))
      throw new Error("RESOURCE_AUDIT_RULES_EMPTY")
    for (const line of output.split("\n"))
      if (IPTABLES_TOKEN.test(line)) count += 1
  }
  return count
}

/** Peephole-shaped netns/link/rule counts in the host network namespace.
 * Also reused (read-only) by the B2 server-crash inventory. */
export async function networkState(operations: ResourceAuditOperations) {
  await assertHostNetworkNamespace(operations)
  return {
    namespaces: (await netnsNames(operations)).length,
    links: await peepholeLinks(operations),
    rules: await peepholeRules(operations),
  }
}

/** Before the child: record test-root mounts and REQUIRE a host with no
 * Peephole-shaped network state, so every later match is attributable to this
 * run. Throws (the controller then refuses to run the child) otherwise. */
export async function snapshotResources(
  scope: ResourceAuditScope,
  operations: ResourceAuditOperations,
): Promise<ResourceSnapshot> {
  const mounts = await relevantMounts(scope, operations)
  // Read before any inventory command runs, so no audit helper is included.
  const processes = await unitProcesses(scope, operations)
  if (processes.some((p) => p.pid !== scope.pid && p.ppid !== scope.pid))
    throw new Error("RESOURCE_AUDIT_BASELINE_NOT_CLEAN")
  const network = await networkState(operations)
  if (network.namespaces + network.links + network.rules > 0)
    throw new Error("RESOURCE_AUDIT_BASELINE_NOT_CLEAN")
  if (mounts.some((m) => NETNS_DIRECTORIES.some((d) => m.startsWith(`${d}/`))))
    throw new Error("RESOURCE_AUDIT_BASELINE_NOT_CLEAN")
  return { mounts, processes: processes.map(processKey) }
}

function unitCgroup(scope: ResourceAuditScope, contents: string): string {
  const lines = contents.split("\n").filter(Boolean)
  const line = lines[0]
  // Pure cgroup v2 only: exactly one `0::<path>` entry ending in the unit.
  if (lines.length !== 1 || !line?.startsWith("0::"))
    throw new Error("RESOURCE_AUDIT_CGROUP_INVALID")
  const relative = line.slice(3)
  if (
    !relative.startsWith("/") ||
    !relative.endsWith(`/${scope.unit}`) ||
    relative.split("/").includes("..")
  )
    throw new Error("RESOURCE_AUDIT_CGROUP_INVALID")
  return relative
}

function cgroup2Mounted(mountInfo: string): boolean {
  return mountInfo.split("\n").some((line) => {
    const [left, right] = line.split(" - ")
    return (
      left?.split(" ")[4] === "/sys/fs/cgroup" && right?.startsWith("cgroup2 ")
    )
  })
}

/** Every PID in the unit's cgroup and ALL descendant cgroups. Unreadable,
 * oversized or too-deep trees reject (INCOMPLETE), never count as empty. */
async function cgroupTreePids(
  root: string,
  operations: ResourceAuditOperations,
): Promise<number[]> {
  const pids: number[] = []
  const pending: Array<[string, number]> = [[root, 0]]
  let visited = 0
  for (let next = pending.pop(); next; next = pending.pop()) {
    const [directory, depth] = next
    visited += 1
    if (visited > MAX_CGROUPS || depth > MAX_CGROUP_DEPTH)
      throw new Error("RESOURCE_AUDIT_CGROUP_BOUND")
    for (const line of (
      await operations.readFile(`${directory}/cgroup.procs`)
    ).split("\n")) {
      if (!line) continue
      if (!/^[0-9]+$/.test(line))
        throw new Error("RESOURCE_AUDIT_PROCS_INVALID")
      pids.push(Number(line))
    }
    for (const entry of await operations.readdir(directory))
      if (entry.directory)
        pending.push([`${directory}/${entry.name}`, depth + 1])
  }
  return pids
}

interface UnitProcess {
  pid: number
  ppid: number
  start: string
}

async function processStat(
  pid: number,
  operations: ResourceAuditOperations,
): Promise<UnitProcess> {
  const stat = await operations.readFile(`/proc/${String(pid)}/stat`)
  // proc(5): `pid (comm) state ppid ... starttime(22) ...`; comm may contain
  // spaces/parentheses, so fields are counted after the LAST `)`.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
  const ppid = Number(fields[1])
  const start = fields[19] ?? ""
  if (!Number.isSafeInteger(ppid) || ppid < 0 || !/^[0-9]+$/.test(start))
    throw new Error("RESOURCE_AUDIT_STAT_INVALID")
  return { pid, ppid, start }
}

async function parentPid(
  pid: number,
  operations: ResourceAuditOperations,
): Promise<number> {
  return (await processStat(pid, operations)).ppid
}

function processKey(process: UnitProcess): string {
  return `${String(process.pid)}:${process.start}`
}

/** All processes in the exact unit's cgroup tree. The controller must be
 * among them; a PID that exits between listing and stat is gone, not hidden. */
async function unitProcesses(
  scope: ResourceAuditScope,
  operations: ResourceAuditOperations,
): Promise<UnitProcess[]> {
  if (!cgroup2Mounted(await operations.readFile("/proc/self/mountinfo")))
    throw new Error("RESOURCE_AUDIT_CGROUP2_MISSING")
  const relative = unitCgroup(
    scope,
    await operations.readFile("/proc/self/cgroup"),
  )
  const processes: UnitProcess[] = []
  for (const pid of await cgroupTreePids(
    `/sys/fs/cgroup${relative}`,
    operations,
  )) {
    try {
      processes.push(await processStat(pid, operations))
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  if (!processes.some((p) => p.pid === scope.pid))
    throw new Error("RESOURCE_AUDIT_CONTROLLER_MISSING")
  return processes
}

/** Processes that moved out of the unit cgroup still name a test root in
 * their argv (runsc always receives `--root <test runsc root>`), mirroring
 * m12-test-host.sh's teardown check. argv is compared, never emitted. The
 * roots therefore must not appear in any other live argv (the R5-2 unit gets
 * them from an EnvironmentFile, not `systemd-run --setenv`). */
async function processesReferencingRoots(
  scope: ResourceAuditScope,
  operations: ResourceAuditOperations,
): Promise<number> {
  const excluded = new Set<number>()
  for (let pid = scope.pid, depth = 0; pid > 0; depth += 1) {
    if (depth > 128) throw new Error("RESOURCE_AUDIT_ANCESTRY_BOUND")
    excluded.add(pid)
    pid = await parentPid(pid, operations)
  }
  const entries = (await operations.readdir("/proc")).filter((entry) =>
    /^[0-9]+$/.test(entry.name),
  )
  if (entries.length === 0 || entries.length > MAX_PROCESSES)
    throw new Error("RESOURCE_AUDIT_PROC_BOUND")
  let count = 0
  for (const entry of entries) {
    if (excluded.has(Number(entry.name))) continue
    let argv: string
    try {
      argv = await operations.readFile(`/proc/${entry.name}/cmdline`)
    } catch (error) {
      if (isMissing(error)) continue // exited meanwhile
      throw error
    }
    if (
      scope.roots.some((root) =>
        argv.split("\0").some((arg) => arg.includes(root)),
      )
    )
      count += 1
  }
  return count
}

/** After the child exits, while the unit is alive. Each area is independent:
 * one unreadable area cannot hide another area's FAIL. */
export async function auditResources(
  scope: ResourceAuditScope,
  before: ResourceSnapshot,
  operations: ResourceAuditOperations,
): Promise<ResourceAuditResult> {
  const mounts = await guarded(async () => {
    const after = await relevantMounts(scope, operations)
    return JSON.stringify(after) === JSON.stringify(before.mounts)
      ? "PASS"
      : "FAIL"
  })
  // Read the cgroup tree while no audit helper command is running.
  const processes = await guarded(async () => {
    const allowed = new Set(before.processes)
    const statuses: ScanStatus[] = [
      (await unitProcesses(scope, operations)).every((p) =>
        allowed.has(processKey(p)),
      )
        ? "PASS"
        : "FAIL",
      (await processesReferencingRoots(scope, operations)) === 0
        ? "PASS"
        : "FAIL",
    ]
    return combineScanStatuses(statuses)
  })
  const network = await guarded(async () => {
    const state = await networkState(operations)
    return state.namespaces + state.links + state.rules === 0 ? "PASS" : "FAIL"
  })
  return { mounts, processes, network }
}

export function combineResourceAudit(result: ResourceAuditResult): ScanStatus {
  return combineScanStatuses([result.mounts, result.processes, result.network])
}
