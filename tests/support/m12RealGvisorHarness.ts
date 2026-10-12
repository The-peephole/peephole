import { createHash, randomUUID } from "node:crypto"
import {
  lstat as fsLstat,
  mkdtemp as fsMkdtemp,
  readFile as fsReadFile,
  readdir as fsReaddir,
  realpath as fsRealpath,
  rm as fsRm,
  rmdir as fsRmdir,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from "node:fs/promises"
import path from "node:path/posix"

import {
  BoundedRawValueScanError,
  scanRegularFilesForRawValue,
  type BoundedRawValueScanOptions,
} from "./boundedRawValueScanner"

/**
 * Safety boundary for the M12 real Linux/gVisor harness
 * (tests/realUserEnvironmentRuntime.test.ts, docs/M12_REAL_GVISOR_VERIFICATION.md).
 *
 * Unlike the older M10 helpers, nothing here ever falls back to a default
 * path: every root must be named explicitly, canonical, disjoint from every
 * production root, and every destructive step targets only a per-run
 * directory this process created and can still prove it owns.
 */

export const M12_REAL_GATES = [
  "PEEPHOLE_REAL_GVISOR_TESTS",
  "PEEPHOLE_M12_REAL_GVISOR_TESTS",
] as const

export const M12_PATH_VARIABLES = {
  workspaceRoot: "PEEPHOLE_M12_TEST_WORKSPACE_ROOT",
  runscRoot: "PEEPHOLE_M12_TEST_RUNSC_ROOT",
  baseRootfs: "PEEPHOLE_M12_TEST_BASE_ROOTFS",
  tmpfsRoot: "PEEPHOLE_M12_TEST_TMPFS_ROOT",
} as const

export type M12RootKind = keyof typeof M12_PATH_VARIABLES

export class M12HarnessPreflightError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "M12HarnessPreflightError"
  }
}

/** A directory this run created but could not prove safe to remove. Its
 * exact path is reported, never deleted on a guess. */
export class M12HarnessPreservedDirectoryError extends M12HarnessPreflightError {
  constructor(
    message: string,
    readonly preservedPath: string,
  ) {
    super(`${message} It is preserved for manual review: ${preservedPath}`)
    this.name = "M12HarnessPreservedDirectoryError"
  }
}

/** Both gates, each exactly "1" -- never a truthy alternative. */
export function m12RealSuiteEnabled(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return M12_REAL_GATES.every((gate) => environment[gate] === "1")
}

/** Production roots (and the shared namespace directories) that a test root
 * must neither equal, contain, nor sit inside. */
export const PRODUCTION_RESOURCE_ROOTS: readonly string[] = [
  "/run/peephole/secrets",
  "/run/peephole/db-credentials",
  "/run/peephole/user-env",
  "/var/lib/peephole/base-rootfs",
  "/var/lib/peephole/jobs",
  "/var/lib/peephole/artifacts",
  "/var/run/peephole/runsc",
  "/var/run/peephole/net-leases",
  "/run/netns",
  "/var/run/netns",
]

/** Broad system directories: a test root may live below these, but never
 * be one of them. */
const SYSTEM_ROOTS: readonly string[] = [
  "/",
  "/run",
  "/run/peephole",
  "/var",
  "/var/lib",
  "/var/lib/peephole",
  "/var/run",
  "/var/run/peephole",
  "/tmp",
  "/etc",
  "/usr",
  "/home",
  "/root",
  "/opt",
  "/dev",
  "/proc",
  "/sys",
]

/** Operator overrides of production roots are protected too, so a host
 * configured with non-default paths is still covered. */
const PRODUCTION_OVERRIDE_VARIABLES: readonly string[] = [
  "PEEPHOLE_GVISOR_BUNDLES_DIR",
  "PEEPHOLE_GVISOR_BASE_ROOTFS",
  "PEEPHOLE_GVISOR_RUNSC_ROOT",
  "PEEPHOLE_ARTIFACT_STORAGE_DIR",
  "PEEPHOLE_GENERATED_SECRET_ROOT",
  "PEEPHOLE_DATABASE_CREDENTIAL_ROOT",
  "PEEPHOLE_USER_ENVIRONMENT_ROOT",
]

export interface M12HarnessConfig {
  workspaceRoot: string
  runscRoot: string
  baseRootfs: string
  tmpfsRoot: string
}

export interface PathInspection {
  lstat(candidate: string): Promise<{
    isDirectory(): boolean
    isSymbolicLink(): boolean
    isFile(): boolean
    dev: number | bigint
    ino: number | bigint
    uid: number
    mode: number
    size: number
  }>
  realpath(candidate: string): Promise<string>
}

const defaultInspection: PathInspection = {
  lstat: (candidate) => fsLstat(candidate),
  realpath: (candidate) => fsRealpath(candidate),
}

export function protectedResourceRoots(
  environment: Readonly<Record<string, string | undefined>>,
): string[] {
  const overrides = PRODUCTION_OVERRIDE_VARIABLES.map((name) =>
    environment[name]?.trim(),
  ).filter((value): value is string => Boolean(value))
  return [...PRODUCTION_RESOURCE_ROOTS, ...overrides].map((root) =>
    path.resolve(root),
  )
}

/**
 * Reads and validates the four mandatory roots. Throws
 * `M12HarnessPreflightError` (naming only the variable, never a value other
 * than the offending path) unless every root is: set, absolute, an existing
 * ordinary directory reached without any symlink, not a system directory,
 * not equal to / inside / containing any production resource root, and
 * disjoint from the other three roots.
 */
export async function readM12HarnessConfig(
  environment: Readonly<Record<string, string | undefined>>,
  inspection: PathInspection = defaultInspection,
): Promise<M12HarnessConfig> {
  const protectedRoots = protectedResourceRoots(environment)
  const config = {} as Record<M12RootKind, string>
  for (const kind of Object.keys(M12_PATH_VARIABLES) as M12RootKind[]) {
    const variable = M12_PATH_VARIABLES[kind]
    const configured = environment[variable]?.trim()
    if (!configured) {
      throw new M12HarnessPreflightError(
        `${variable} is required; the M12 harness never falls back to a default path.`,
      )
    }
    config[kind] = await validateTestRoot(
      variable,
      configured,
      protectedRoots,
      inspection,
    )
  }
  const entries = Object.entries(config) as Array<[M12RootKind, string]>
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const [leftKind, leftPath] = entries[left]!
      const [rightKind, rightPath] = entries[right]!
      if (pathsOverlap(leftPath, rightPath)) {
        throw new M12HarnessPreflightError(
          `${M12_PATH_VARIABLES[leftKind]} and ${M12_PATH_VARIABLES[rightKind]} must not overlap.`,
        )
      }
    }
  }
  return config
}

async function validateTestRoot(
  variable: string,
  configured: string,
  protectedRoots: readonly string[],
  inspection: PathInspection,
): Promise<string> {
  if (!configured.startsWith("/") || configured.includes("\0")) {
    throw new M12HarnessPreflightError(`${variable} must be an absolute path.`)
  }
  const resolved = path.resolve(configured)
  if (SYSTEM_ROOTS.includes(resolved)) {
    throw new M12HarnessPreflightError(
      `${variable} must be a dedicated directory, not the system directory ${resolved}.`,
    )
  }
  for (const root of protectedRoots) {
    if (pathsOverlap(resolved, root)) {
      throw new M12HarnessPreflightError(
        `${variable} (${resolved}) overlaps the protected production root ${root}.`,
      )
    }
  }
  let stats
  try {
    stats = await inspection.lstat(resolved)
  } catch {
    throw new M12HarnessPreflightError(
      `${variable} (${resolved}) must already exist.`,
    )
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new M12HarnessPreflightError(
      `${variable} (${resolved}) must be an ordinary directory, not a symlink.`,
    )
  }
  const canonical = await inspection.realpath(resolved)
  if (canonical !== resolved) {
    throw new M12HarnessPreflightError(
      `${variable} (${resolved}) must not traverse a symlink (resolves to ${canonical}).`,
    )
  }
  for (const root of protectedRoots) {
    if (pathsOverlap(canonical, root)) {
      throw new M12HarnessPreflightError(
        `${variable} (${canonical}) overlaps the protected production root ${root}.`,
      )
    }
  }
  return canonical
}

/** Paths and gate states only -- never an environment value, credential, or
 * the synthetic test value. */
export function formatM12PreflightSummary(
  config: M12HarnessConfig,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return JSON.stringify({
    gates: Object.fromEntries(
      M12_REAL_GATES.map((gate) => [gate, environment[gate] === "1"]),
    ),
    roots: config,
    protectedRoots: protectedResourceRoots(environment),
  })
}

// ------------------------------------------------ Production host guard

/**
 * Fixed paths whose presence means this host runs (or ran) Peephole
 * production: the production state, credential, and configuration roots.
 * The harness also creates host-global network state (netns, veth, iptables
 * chains), so path isolation alone is not enough: on such a host it refuses
 * outright, with no override.
 *
 * Absence is NOT proof the host never ran Peephole (a removed installation
 * leaves no trace here); the dedicated-host requirement stays mandatory.
 */
export const PRODUCTION_HOST_MARKERS: readonly string[] = [
  "/etc/peephole",
  "/var/lib/peephole",
  "/var/lib/peephole/jobs",
  "/var/lib/peephole/base-rootfs",
  "/var/lib/peephole/artifacts",
  "/run/peephole/secrets",
  "/run/peephole/db-credentials",
  "/run/peephole/user-env",
  "/var/run/peephole/runsc",
]

/** systemd's unit search path for system units (systemd.unit(5)): any entry
 * named `peephole*` (a unit, a `.d` drop-in, or an enablement link one level
 * down in a `*.wants`/`*.requires` directory) counts as a marker. Listings
 * are bounded; an unlistable or oversized directory is treated as a marker. */
export const SYSTEMD_UNIT_DIRECTORIES: readonly string[] = [
  "/etc/systemd/system",
  "/run/systemd/system",
  "/usr/local/lib/systemd/system",
  "/usr/lib/systemd/system",
  "/lib/systemd/system",
]

const MAX_UNIT_DIRECTORY_ENTRIES = 4_096

export interface HostMarkerInspection {
  lstat(candidate: string): Promise<unknown>
  readdir(candidate: string): Promise<string[]>
}

const defaultHostMarkerInspection: HostMarkerInspection = {
  lstat: (candidate) => fsLstat(candidate),
  readdir: (candidate) => fsReaddir(candidate),
}

export async function findProductionHostMarkers(
  inspection: HostMarkerInspection = defaultHostMarkerInspection,
): Promise<string[]> {
  const found: string[] = []
  for (const marker of PRODUCTION_HOST_MARKERS) {
    try {
      await inspection.lstat(marker)
      found.push(marker)
    } catch (error) {
      // Cannot prove absence: treat as present (fail closed).
      if (!isMissing(error)) found.push(marker)
    }
  }
  for (const directory of SYSTEMD_UNIT_DIRECTORIES) {
    const entries = await listBounded(directory, inspection)
    if (entries === "unknown") {
      found.push(directory)
      continue
    }
    for (const entry of entries) {
      if (entry.startsWith("peephole")) {
        found.push(path.join(directory, entry))
      } else if (entry.endsWith(".wants") || entry.endsWith(".requires")) {
        const child = path.join(directory, entry)
        const linked = await listBounded(child, inspection)
        if (linked === "unknown") {
          found.push(child)
          continue
        }
        for (const link of linked) {
          if (link.startsWith("peephole")) found.push(path.join(child, link))
        }
      }
    }
  }
  return found
}

async function listBounded(
  directory: string,
  inspection: HostMarkerInspection,
): Promise<string[] | "unknown"> {
  let entries: string[]
  try {
    entries = await inspection.readdir(directory)
  } catch (error) {
    return isMissing(error) ? [] : "unknown"
  }
  return entries.length > MAX_UNIT_DIRECTORY_ENTRIES ? "unknown" : entries
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
}

/** Mount points at or below `root` according to `/proc/self/mountinfo`
 * contents. A recursive delete must never descend into one. */
export function mountsWithin(root: string, mountInfo: string): string[] {
  const mounts: string[] = []
  for (const line of mountInfo.split("\n")) {
    const fields = line.split(" ")
    const mountPoint = fields[4]
    if (!mountPoint) continue
    const decoded = mountPoint.replace(
      /\\([0-7]{3})/g,
      (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)),
    )
    if (isWithin(root, decoded)) mounts.push(decoded)
  }
  return mounts
}

// ---------------------------------------------------------------- Rootfs

export interface RootfsInspection {
  lstat: PathInspection["lstat"]
  readFile(candidate: string): Promise<Buffer>
}

const REQUIRED_EMPTY_PLACEHOLDERS = [
  "run/secrets/env",
  "run/secrets/database-url",
  "run/secrets/user-env",
] as const

/**
 * A dedicated test rootfs is acceptable only when it carries the exact
 * bootstrap of this checkout (byte-for-byte SHA-256 match -- a stale M10/M11
 * bootstrap that merely exists is refused), the three empty root-owned 0644
 * credential placeholders, and a regular Node binary. Returns every problem
 * found; an empty list means the rootfs matches.
 */
export async function inspectM12TestRootfs(
  baseRootfs: string,
  expectedBootstrap: Buffer,
  inspection: RootfsInspection = {
    lstat: (candidate) => fsLstat(candidate),
    readFile: (candidate) => fsReadFile(candidate),
  },
): Promise<string[]> {
  const problems: string[] = []
  const at = (relative: string) => path.join(baseRootfs, relative)
  const describe = async (relative: string) =>
    inspection.lstat(at(relative)).catch(() => null)

  const node = await describe("usr/local/bin/node")
  if (!node || node.isSymbolicLink() || !node.isFile()) {
    problems.push("usr/local/bin/node is missing or not a regular file")
  }

  const secretsDir = await describe("run/secrets")
  if (!secretsDir || secretsDir.isSymbolicLink() || !secretsDir.isDirectory()) {
    problems.push("run/secrets is missing or not a directory")
  }
  for (const relative of REQUIRED_EMPTY_PLACEHOLDERS) {
    const entry = await describe(relative)
    if (!entry || entry.isSymbolicLink() || !entry.isFile()) {
      problems.push(`${relative} is missing or not a regular file`)
      continue
    }
    if (entry.uid !== 0) problems.push(`${relative} is not root-owned`)
    if ((entry.mode & 0o7777) !== 0o644) {
      problems.push(`${relative} does not have mode 0644`)
    }
    if (entry.size !== 0) problems.push(`${relative} is not empty`)
  }

  const bootstrapPath = "opt/peephole/secret-bootstrap.mjs"
  const bootstrap = await describe(bootstrapPath)
  if (!bootstrap || bootstrap.isSymbolicLink() || !bootstrap.isFile()) {
    problems.push(`${bootstrapPath} is missing or not a regular file`)
  } else {
    if (bootstrap.uid !== 0) problems.push(`${bootstrapPath} is not root-owned`)
    if ((bootstrap.mode & 0o7777) !== 0o555) {
      problems.push(`${bootstrapPath} does not have mode 0555`)
    }
    const contents = await inspection
      .readFile(at(bootstrapPath))
      .catch(() => null)
    if (!contents) {
      problems.push(`${bootstrapPath} could not be read`)
    } else if (sha256(contents) !== sha256(expectedBootstrap)) {
      problems.push(
        `${bootstrapPath} does not match this checkout's scripts/gvisor/secret-bootstrap.mjs (stale rootfs)`,
      )
    }
  }
  return problems
}

// ------------------------------------------------- Owned run directories

export const OWNER_MARKER_FILE = ".peephole-m12-harness-owner.json"

export interface OwnedRunDirectory {
  readonly kind: M12RootKind
  readonly parent: string
  readonly path: string
  readonly runId: string
  readonly dev: number | bigint
  readonly ino: number | bigint
}

export interface OwnedDirectoryOperations extends PathInspection {
  mkdtemp(prefix: string): Promise<string>
  writeFile(candidate: string, contents: string): Promise<void>
  readFile(candidate: string): Promise<string>
  rm(candidate: string): Promise<void>
  /** Non-recursive: used only to undo a just-created, still-empty directory. */
  rmdir(candidate: string): Promise<void>
  unlink(candidate: string): Promise<void>
  /** `/proc/self/mountinfo`; unreadable means removal is refused. */
  readMountInfo(): Promise<string>
}

export const defaultOwnedDirectoryOperations: OwnedDirectoryOperations = {
  ...defaultInspection,
  mkdtemp: (prefix) => fsMkdtemp(prefix),
  writeFile: (candidate, contents) =>
    fsWriteFile(candidate, contents, { flag: "wx", mode: 0o600 }),
  readFile: (candidate) => fsReadFile(candidate, "utf8"),
  rm: (candidate) => fsRm(candidate, { recursive: true, force: false }),
  rmdir: (candidate) => fsRmdir(candidate),
  unlink: (candidate) => fsUnlink(candidate),
  readMountInfo: () => fsReadFile("/proc/self/mountinfo", "utf8"),
}

/**
 * Creates a never-before-used child of an already validated root and records
 * its identity in memory (random run id, canonical path, device/inode). The
 * marker file only mirrors that record for operators; it can never authorize
 * a deletion on its own, because the in-memory run id must also match.
 */
export async function createOwnedRunDirectory(
  parent: string,
  kind: M12RootKind,
  operations: OwnedDirectoryOperations = defaultOwnedDirectoryOperations,
): Promise<OwnedRunDirectory> {
  // mkdtemp either creates the directory or nothing. From here until the
  // marker exists, every failure must either undo exactly this directory or
  // report its path -- it may never become a silent orphan (Finding 2).
  const created = await operations.mkdtemp(
    path.join(parent, `peephole-m12-${kind}-`),
  )
  let stats: Awaited<ReturnType<PathInspection["lstat"]>>
  try {
    const canonical = await operations.realpath(created)
    if (canonical !== created || path.dirname(canonical) !== parent) {
      throw new M12HarnessPreservedDirectoryError(
        "A created run directory does not resolve to a direct child of its validated root.",
        created,
      )
    }
    stats = await operations.lstat(created)
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new M12HarnessPreservedDirectoryError(
        "A created run directory is not an ordinary directory.",
        created,
      )
    }
  } catch (error) {
    if (error instanceof M12HarnessPreservedDirectoryError) throw error
    throw new M12HarnessPreservedDirectoryError(
      "A created run directory could not be inspected.",
      created,
    )
  }
  const owned: OwnedRunDirectory = {
    kind,
    parent,
    path: created,
    runId: randomUUID(),
    dev: stats.dev,
    ino: stats.ino,
  }
  try {
    await operations.writeFile(
      path.join(created, OWNER_MARKER_FILE),
      markerContents(owned),
    )
  } catch {
    if (await undoUnmarkedDirectory(owned, operations)) {
      throw new M12HarnessPreflightError(
        "A run directory's ownership marker could not be written; the directory was removed.",
      )
    }
    throw new M12HarnessPreservedDirectoryError(
      "A run directory's ownership marker could not be written, and the directory could not be proven safe to remove.",
      created,
    )
  }
  return owned
}

/**
 * Undoes a directory this call just created whose marker write failed --
 * only if it is still the same ordinary, canonical, direct child (same
 * device/inode). A partial marker is unlinked; the directory is removed with
 * a NON-recursive rmdir, so any unexpected content makes removal fail and
 * the directory is preserved instead.
 */
async function undoUnmarkedDirectory(
  owned: OwnedRunDirectory,
  operations: OwnedDirectoryOperations,
): Promise<boolean> {
  try {
    const stats = await operations.lstat(owned.path)
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      stats.dev !== owned.dev ||
      stats.ino !== owned.ino ||
      (await operations.realpath(owned.path)) !== owned.path ||
      path.dirname(owned.path) !== owned.parent
    ) {
      return false
    }
    const markerPath = path.join(owned.path, OWNER_MARKER_FILE)
    const marker = await operations.lstat(markerPath).catch(() => null)
    if (marker) {
      if (marker.isSymbolicLink() || !marker.isFile()) return false
      await operations.unlink(markerPath)
    }
    await operations.rmdir(owned.path)
    return true
  } catch {
    return false
  }
}

/** Re-proves ownership immediately before cleanup. */
export async function verifyOwnedRunDirectory(
  owned: OwnedRunDirectory,
  operations: OwnedDirectoryOperations = defaultOwnedDirectoryOperations,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    if (path.dirname(owned.path) !== owned.parent) {
      return { ok: false, reason: "not a direct child of its root" }
    }
    const stats = await operations.lstat(owned.path)
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return { ok: false, reason: "no longer an ordinary directory" }
    }
    if (stats.dev !== owned.dev || stats.ino !== owned.ino) {
      return { ok: false, reason: "device/inode changed since creation" }
    }
    if ((await operations.realpath(owned.path)) !== owned.path) {
      return { ok: false, reason: "path now traverses a symlink" }
    }
    const markerPath = path.join(owned.path, OWNER_MARKER_FILE)
    const marker = await operations.lstat(markerPath)
    if (marker.isSymbolicLink() || !marker.isFile()) {
      return { ok: false, reason: "owner marker is not a regular file" }
    }
    if ((await operations.readFile(markerPath)) !== markerContents(owned)) {
      return { ok: false, reason: "owner marker does not match this run" }
    }
    return { ok: true }
  } catch {
    return { ok: false, reason: "ownership could not be inspected" }
  }
}

/** Removes the run directory only after re-proving ownership; otherwise
 * preserves it and says why. */
export async function removeOwnedRunDirectory(
  owned: OwnedRunDirectory,
  operations: OwnedDirectoryOperations = defaultOwnedDirectoryOperations,
): Promise<{ removed: true } | { removed: false; reason: string }> {
  const verified = await verifyOwnedRunDirectory(owned, operations)
  if (!verified.ok) return { removed: false, reason: verified.reason }
  let mountInfo: string
  try {
    mountInfo = await operations.readMountInfo()
  } catch {
    return { removed: false, reason: "mount table could not be read" }
  }
  const mounts = mountsWithin(owned.path, mountInfo)
  if (mounts.length > 0) {
    return {
      removed: false,
      reason: `still has ${String(mounts.length)} mount(s) inside`,
    }
  }
  await operations.rm(owned.path)
  return { removed: true }
}

function markerContents(owned: OwnedRunDirectory): string {
  return `${JSON.stringify({
    schema: "peephole-m12-real-gvisor-harness/v1",
    kind: owned.kind,
    runId: owned.runId,
    path: owned.path,
  })}\n`
}

/**
 * Creates the three per-run directories; if any creation fails, every
 * directory already created is released (ownership-checked) before the
 * error propagates.
 */
export async function createOwnedRunSet(
  config: M12HarnessConfig,
  operations: OwnedDirectoryOperations = defaultOwnedDirectoryOperations,
): Promise<M12RunDirectories> {
  const created: OwnedRunDirectory[] = []
  try {
    for (const kind of ["workspaceRoot", "runscRoot", "tmpfsRoot"] as const) {
      created.push(
        await createOwnedRunDirectory(config[kind], kind, operations),
      )
    }
  } catch (error) {
    const preserved = [
      ...(error instanceof M12HarnessPreservedDirectoryError
        ? [error.preservedPath]
        : []),
      ...(await releaseOwnedRunDirectories(created, operations)),
    ]
    if (preserved.length > 0 && error instanceof Error) {
      Object.assign(error, { preservedRunDirectories: preserved })
    }
    throw error
  }
  const [workspace, runsc, tmpfs] = created as [
    OwnedRunDirectory,
    OwnedRunDirectory,
    OwnedRunDirectory,
  ]
  return { workspace, runsc, tmpfs }
}

/** Runs `setup`; if it throws, releases the run set before rethrowing, so a
 * failed preflight (e.g. a non-tmpfs root) leaves nothing behind. */
export async function withSetupRollback<T>(
  runs: M12RunDirectories,
  setup: () => Promise<T>,
  operations: OwnedDirectoryOperations = defaultOwnedDirectoryOperations,
): Promise<T> {
  try {
    return await setup()
  } catch (error) {
    const preserved = await releaseOwnedRunDirectories(
      [runs.workspace, runs.runsc, runs.tmpfs],
      operations,
    )
    if (preserved.length > 0 && error instanceof Error) {
      Object.assign(error, { preservedRunDirectories: preserved })
    }
    throw error
  }
}

/** Ownership-checked removal of each directory; returns the ones preserved
 * (with a reason) instead of guessing. */
export async function releaseOwnedRunDirectories(
  directories: readonly OwnedRunDirectory[],
  operations: OwnedDirectoryOperations = defaultOwnedDirectoryOperations,
): Promise<string[]> {
  const preserved: string[] = []
  for (const directory of directories) {
    const outcome = await removeOwnedRunDirectory(directory, operations).catch(
      () => ({ removed: false as const, reason: "removal failed" }),
    )
    if (!outcome.removed)
      preserved.push(`${directory.path} (${outcome.reason})`)
  }
  return preserved
}

// --------------------------------------------- Component path derivation

export interface M12RunDirectories {
  workspace: OwnedRunDirectory
  runsc: OwnedRunDirectory
  tmpfs: OwnedRunDirectory
}

export interface M12ComponentPaths {
  bundlesRootDir: string
  leaseDir: string
  runscRootDir: string
  userEnvironmentRoot: string
  generatedSecretRoot: string
  databaseCredentialRoot: string
  baseRootfsImage: string
}

/**
 * Every path any real component receives. Each one is derived from an owned
 * run directory (or the validated test rootfs) and re-checked against the
 * protected production roots, so no constructor's production default can be
 * reached by omission.
 */
export function deriveM12ComponentPaths(
  config: M12HarnessConfig,
  runs: M12RunDirectories,
  protectedRoots: readonly string[],
): M12ComponentPaths {
  const paths: M12ComponentPaths = {
    bundlesRootDir: path.join(runs.workspace.path, "bundles"),
    leaseDir: path.join(runs.workspace.path, "network-leases"),
    runscRootDir: path.join(runs.runsc.path, "state"),
    userEnvironmentRoot: path.join(runs.tmpfs.path, "user-env"),
    generatedSecretRoot: path.join(runs.tmpfs.path, "secrets"),
    databaseCredentialRoot: path.join(runs.tmpfs.path, "db-credentials"),
    baseRootfsImage: config.baseRootfs,
  }
  const owners: Record<keyof M12ComponentPaths, string> = {
    bundlesRootDir: runs.workspace.path,
    leaseDir: runs.workspace.path,
    runscRootDir: runs.runsc.path,
    userEnvironmentRoot: runs.tmpfs.path,
    generatedSecretRoot: runs.tmpfs.path,
    databaseCredentialRoot: runs.tmpfs.path,
    baseRootfsImage: config.baseRootfs,
  }
  for (const key of Object.keys(paths) as Array<keyof M12ComponentPaths>) {
    if (!isWithin(owners[key], paths[key])) {
      throw new M12HarnessPreflightError(`${key} escapes its owned root.`)
    }
    for (const root of protectedRoots) {
      if (pathsOverlap(paths[key], root)) {
        throw new M12HarnessPreflightError(
          `${key} overlaps the protected production root ${root}.`,
        )
      }
    }
  }
  return paths
}

// ---------------------------------------------------------- Scan status

export type ScanStatus = "PASS" | "FAIL" | "INCOMPLETE"

/** The bounded scanner throws when it cannot finish; this maps that to an
 * explicit INCOMPLETE so an unreadable path is never reported as clean. */
export async function scanForRawValueStatus(
  rootDir: string,
  rawValue: string,
  options: BoundedRawValueScanOptions = {},
): Promise<ScanStatus> {
  try {
    const result = await scanRegularFilesForRawValue(rootDir, rawValue, options)
    return result.found ? "FAIL" : "PASS"
  } catch (error) {
    if (error instanceof BoundedRawValueScanError) return "INCOMPLETE"
    throw error
  }
}

/** One required file, read in full; unreadable is INCOMPLETE. */
export async function scanFileForRawValueStatus(
  filePath: string,
  rawValue: string,
  readFile: (candidate: string) => Promise<Buffer> = (candidate) =>
    fsReadFile(candidate),
): Promise<ScanStatus> {
  try {
    const contents = await readFile(filePath)
    return contents.includes(Buffer.from(rawValue, "utf8")) ? "FAIL" : "PASS"
  } catch {
    return "INCOMPLETE"
  }
}

/** FAIL dominates; otherwise any INCOMPLETE prevents a PASS. */
export function combineScanStatuses(
  statuses: readonly ScanStatus[],
): ScanStatus {
  if (statuses.length === 0) return "INCOMPLETE"
  if (statuses.includes("FAIL")) return "FAIL"
  if (statuses.includes("INCOMPLETE")) return "INCOMPLETE"
  return "PASS"
}

// ---------------------------------------------------- Cleanup ordering

/**
 * Runs the scenario, then EVERY cleanup step independently and in order --
 * a failed assertion or a failing cleanup step never skips a later one.
 * Rethrows the scenario error (with cleanup failures attached) or, if only
 * cleanup failed, an AggregateError of those failures.
 */
export async function runWithOwnedCleanup<T>(
  scenario: () => Promise<T>,
  cleanups: ReadonlyArray<() => Promise<unknown>>,
): Promise<T> {
  let scenarioError: unknown
  let result: T | undefined
  let succeeded = false
  try {
    result = await scenario()
    succeeded = true
  } catch (error) {
    scenarioError = error
  }
  const cleanupErrors: unknown[] = []
  for (const cleanup of cleanups) {
    try {
      await cleanup()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (!succeeded) {
    if (cleanupErrors.length > 0 && scenarioError instanceof Error) {
      Object.assign(scenarioError, { cleanupErrors })
    }
    throw scenarioError
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "M12 harness cleanup failed.")
  }
  return result as T
}

/** Stops every runtime (newest first), attempting all of them; any failure
 * is reported, never swallowed (Finding 1). */
export async function stopRuntimeHandles(
  handles: ReadonlyArray<{ stop(): Promise<void> }>,
): Promise<void> {
  await attemptAll(
    [...handles].reverse().map((handle) => () => handle.stop()),
    "runtime(s) could not be stopped",
  )
}

/** Destroys every workspace (newest first), attempting all of them. */
export async function destroyWorkspaces(
  workspaces: ReadonlyArray<{ destroy(): Promise<void> }>,
): Promise<void> {
  await attemptAll(
    [...workspaces].reverse().map((workspace) => () => workspace.destroy()),
    "workspace(s) could not be destroyed",
  )
}

async function attemptAll(
  actions: ReadonlyArray<() => Promise<void>>,
  description: string,
): Promise<void> {
  const errors: unknown[] = []
  for (const action of actions) {
    try {
      await action()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `M12 harness cleanup: ${String(errors.length)} ${description}.`,
    )
  }
}

// -------------------------------------------------------------- helpers

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

export function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left)
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  )
}
