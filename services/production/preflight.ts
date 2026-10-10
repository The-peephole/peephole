import { readFileSync } from "node:fs"
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises"
import nativePath from "node:path"
import path from "node:path/posix"

import {
  hasUsableNameserver,
  resolveDnsConfigSource,
} from "../preview-worker/gvisor/dnsConfig"
import { NodeProcessRunner } from "../preview-worker/gvisor/nodeProcessRunner"
import type { ProcessRunner } from "../preview-worker/gvisor/processRunner"
import { type SandboxDiskManager } from "../preview-worker/gvisor/sandboxDisk"
import { assertTmpfsFilesystem } from "../preview-worker/gvisor/generatedSecretFilesystem"
import { SANDBOX_USER_ENVIRONMENT_BOOTSTRAP_FLAG } from "../preview-worker/gvisor/sandboxIdentity"

const CGROUP_V2_MARKER = "/sys/fs/cgroup/cgroup.controllers"
const IP_FORWARD_FILE = "/proc/sys/net/ipv4/ip_forward"
const CHECK_TIMEOUT_MS = 5_000

export interface PreflightCheckResult {
  name: string
  ok: boolean
  detail: string
}

export interface ProductionDiskLayoutOptions {
  bundlesRootDir: string
  artifactStorageDir: string
  prepareDirectory?: (candidate: string) => Promise<void>
  deviceFor?: (candidate: string) => Promise<number | bigint>
}

export interface ProductionPreflightOptions {
  baseRootfsImage: string
  runscBinaryPath?: string
  ipBinaryPath?: string
  iptablesBinaryPath?: string
  ip6tablesBinaryPath?: string
  fallocateBinaryPath?: string
  mkfsExt4BinaryPath?: string
  mountBinaryPath?: string
  umountBinaryPath?: string
  losetupBinaryPath?: string
  findmntBinaryPath?: string
  /** Overridable for tests; defaults to real process spawning. */
  processRunner?: ProcessRunner
  /** Overridable for tests; defaults to reading real host files. */
  readFile?: (filePath: string) => string | null
  /** Overridable for tests; defaults to a real filesystem stat. */
  pathExists?: (candidate: string) => Promise<boolean>
  /** Overridable for tests; defaults to the real resolveDnsConfigSource(). */
  resolveDnsConfigSource?: typeof resolveDnsConfigSource
  /** Overridable for tests; defaults to a real no-follow lstat. */
  inspectRootfsEntry?: (candidate: string) => Promise<RootfsEntry | null>
}

/** The no-follow facts the rootfs secret-contract check needs. */
export interface RootfsEntry {
  kind: "file" | "directory" | "symlink" | "other"
  size: number
  uid: number
  /** Permission bits only (`mode & 0o7777`). */
  mode: number
}

export interface GeneratedSecretRootPreflightOptions {
  secretRootDir: string
  baseRootfsImage: string
  processRunner?: ProcessRunner
  findmntBinaryPath?: string
  prepareDirectory?: (candidate: string) => Promise<void>
}

export interface UserEnvironmentPreflightOptions {
  rootDir: string
  baseRootfsImage: string
  processRunner?: ProcessRunner
  findmntBinaryPath?: string
  prepareDirectory?: (candidate: string) => Promise<void>
  /** Test seams; default to a real no-follow lstat / UTF-8 read. */
  inspectRootfsEntry?: (candidate: string) => Promise<RootfsEntry | null>
  readRootfsFile?: (candidate: string) => Promise<string | null>
}

export interface DatabaseCredentialRootPreflightOptions {
  credentialRootDir: string
  processRunner?: ProcessRunner
  findmntBinaryPath?: string
  prepareDirectory?: (candidate: string) => Promise<void>
}

/**
 * Every host prerequisite `GVisorSandboxProvisioner`/`RunscCommandRunner`/
 * `VethNatNetworkProvisioner` silently assume rather than check themselves --
 * each one was found the hard way, on a real host, during earlier phases of
 * this project (see docs/IMPLEMENTATION_CHECKLIST.md): `runsc`/`ip`/
 * `iptables`/`ip6tables` and loop/ext4 utilities missing from PATH, a
 * non-unified (v1/hybrid) cgroup hierarchy
 * gVisor's resource limits can't attach to, `net.ipv4.ip_forward=0` (which
 * silently drops every forwarded packet before `iptables` FORWARD/NAT rules
 * ever see it -- discovered when a real AWS EC2/WSL2 host reset it on
 * restart), a missing/empty base rootfs image, and a `/etc/resolv.conf`
 * that resolves to nothing but loopback addresses once mounted into a
 * separate network namespace (the systemd-resolved stub bug -- see
 * dnsConfig.ts). Every one of these fails *inside* a job, hours or days
 * after the process started, with an error that looks nothing like its
 * actual cause. Checking all of them together at startup turns that into
 * one clear, immediate refusal to start.
 */
export async function runProductionPreflightChecks(
  options: ProductionPreflightOptions,
): Promise<PreflightCheckResult[]> {
  const processRunner = options.processRunner ?? new NodeProcessRunner()
  const readFile = options.readFile ?? defaultReadFile
  const pathExists = options.pathExists ?? defaultPathExists
  const resolveDns = options.resolveDnsConfigSource ?? resolveDnsConfigSource
  const runscBinaryPath = options.runscBinaryPath ?? "runsc"
  const ipBinaryPath = options.ipBinaryPath ?? "ip"
  const iptablesBinaryPath = options.iptablesBinaryPath ?? "iptables"
  const ip6tablesBinaryPath = options.ip6tablesBinaryPath ?? "ip6tables"
  const fallocateBinaryPath = options.fallocateBinaryPath ?? "fallocate"
  const mkfsExt4BinaryPath = options.mkfsExt4BinaryPath ?? "mkfs.ext4"
  const mountBinaryPath = options.mountBinaryPath ?? "mount"
  const umountBinaryPath = options.umountBinaryPath ?? "umount"
  const losetupBinaryPath = options.losetupBinaryPath ?? "losetup"
  const findmntBinaryPath = options.findmntBinaryPath ?? "findmnt"
  return Promise.all([
    checkBinary(processRunner, "runsc", runscBinaryPath, ["--version"]),
    checkBinary(processRunner, "ip", ipBinaryPath, ["-V"]),
    checkBinary(processRunner, "iptables", iptablesBinaryPath, ["--version"]),
    checkBinary(processRunner, "ip6tables", ip6tablesBinaryPath, ["--version"]),
    checkBinary(processRunner, "fallocate", fallocateBinaryPath, ["--version"]),
    checkBinary(processRunner, "mkfs.ext4", mkfsExt4BinaryPath, ["-V"]),
    checkBinary(processRunner, "mount", mountBinaryPath, ["--version"]),
    checkBinary(processRunner, "umount", umountBinaryPath, ["--version"]),
    checkBinary(processRunner, "losetup", losetupBinaryPath, ["--version"]),
    checkBinary(processRunner, "findmnt", findmntBinaryPath, ["--version"]),
    checkCgroupV2(pathExists),
    checkIpForward(readFile),
    checkBaseRootfsImage(pathExists, options.baseRootfsImage),
    checkBaseRootfsSecretContract(
      options.inspectRootfsEntry ?? defaultInspectRootfsEntry,
      options.baseRootfsImage,
    ),
    checkDnsConfigSource(readFile, resolveDns),
  ])
}

/** Throws a single error listing every failed check when any check fails. */
export async function ensureProductionPreflight(
  options: ProductionPreflightOptions,
): Promise<void> {
  const results = await runProductionPreflightChecks(options)
  const failed = results.filter((result) => !result.ok)

  if (failed.length > 0) {
    throw new Error(
      `Production preflight checks failed (${String(failed.length)}/${String(results.length)}):\n` +
        failed
          .map((result) => `  - ${result.name}: ${result.detail}`)
          .join("\n"),
    )
  }
}

async function checkBinary(
  processRunner: ProcessRunner,
  name: string,
  binaryPath: string,
  versionArgs: string[],
): Promise<PreflightCheckResult> {
  try {
    const result = await processRunner.run(binaryPath, versionArgs, {
      timeoutMs: CHECK_TIMEOUT_MS,
    })

    if (result.exitCode !== 0) {
      return {
        name,
        ok: false,
        detail: `'${binaryPath} ${versionArgs.join(" ")}' exited with code ${String(result.exitCode)}: ${result.stderr || result.stdout}`,
      }
    }

    return {
      name,
      ok: true,
      detail: (result.stdout || result.stderr).trim().split("\n")[0] ?? "ok",
    }
  } catch (error) {
    return {
      name,
      ok: false,
      detail: `'${binaryPath}' is not runnable on PATH: ${errorMessage(error)}`,
    }
  }
}

async function checkCgroupV2(
  pathExists: (candidate: string) => Promise<boolean>,
): Promise<PreflightCheckResult> {
  const ok = await pathExists(CGROUP_V2_MARKER)
  return {
    name: "cgroup v2",
    ok,
    detail: ok
      ? `${CGROUP_V2_MARKER} present (unified hierarchy)`
      : `${CGROUP_V2_MARKER} not found -- this host's cgroups are not on the unified (v2) hierarchy runsc's resource limits require. A hybrid/v1 setup needs to be reconfigured (most current distro kernels default to v2 already).`,
  }
}

function checkIpForward(
  readFile: (filePath: string) => string | null,
): PreflightCheckResult {
  const content = readFile(IP_FORWARD_FILE)?.trim()

  if (content === "1") {
    return { name: "net.ipv4.ip_forward", ok: true, detail: "1" }
  }

  return {
    name: "net.ipv4.ip_forward",
    ok: false,
    detail: `${IP_FORWARD_FILE} reads '${content ?? "<unreadable>"}', not '1' -- the kernel drops every forwarded packet before iptables FORWARD/NAT rules ever see it, so network: sandbox jobs will time out with no obvious cause. Fix with 'sysctl -w net.ipv4.ip_forward=1' (and persist it in /etc/sysctl.d/, since some hosts reset this on every restart).`,
  }
}

async function checkBaseRootfsImage(
  pathExists: (candidate: string) => Promise<boolean>,
  baseRootfsImage: string,
): Promise<PreflightCheckResult> {
  const nodeBinary = path.join(baseRootfsImage, "usr", "local", "bin", "node")
  const ok = await pathExists(nodeBinary)

  return {
    name: "base rootfs image",
    ok,
    detail: ok
      ? `${baseRootfsImage} looks populated (${nodeBinary} present)`
      : `${nodeBinary} not found -- ${baseRootfsImage} is missing or wasn't built with scripts/gvisor/build-base-rootfs.sh.`,
  }
}

/** Exact layout `scripts/gvisor/build-base-rootfs.sh` produces for the
 * credential bind mounts. The M10 generated-secret file and the M11 database
 * credential file are each bind-mounted onto their own placeholder, so an
 * image built before M11-C3 (no placeholders, older bootstrap) must refuse
 * startup here rather than fail inside the first backend runtime. Checked
 * whether or not temporary databases are enabled. */
const ROOTFS_SECRET_CONTRACT: ReadonlyArray<{
  relativePath: string
  kind: RootfsEntry["kind"]
  mode?: number
  empty?: boolean
}> = [
  { relativePath: "run", kind: "directory" },
  { relativePath: "run/secrets", kind: "directory" },
  { relativePath: "run/secrets/env", kind: "file", mode: 0o644, empty: true },
  {
    relativePath: "run/secrets/database-url",
    kind: "file",
    mode: 0o644,
    empty: true,
  },
  { relativePath: "opt", kind: "directory" },
  { relativePath: "opt/peephole", kind: "directory" },
  {
    relativePath: "opt/peephole/secret-bootstrap.mjs",
    kind: "file",
    mode: 0o555,
  },
]

async function checkBaseRootfsSecretContract(
  inspect: (candidate: string) => Promise<RootfsEntry | null>,
  baseRootfsImage: string,
): Promise<PreflightCheckResult> {
  const problems: string[] = []
  for (const expected of ROOTFS_SECRET_CONTRACT) {
    const candidate = path.join(baseRootfsImage, expected.relativePath)
    const entry = await inspect(candidate).catch(() => null)
    if (!entry) {
      problems.push(`${expected.relativePath} is missing`)
    } else if (entry.kind !== expected.kind) {
      problems.push(`${expected.relativePath} is a ${entry.kind}`)
    } else if (expected.kind === "file") {
      if (entry.uid !== 0) {
        problems.push(`${expected.relativePath} is not root-owned`)
      }
      if (expected.mode !== undefined && entry.mode !== expected.mode) {
        problems.push(
          `${expected.relativePath} has mode ${entry.mode.toString(8)}, not ${expected.mode.toString(8)}`,
        )
      }
      if (expected.empty && entry.size !== 0) {
        problems.push(`${expected.relativePath} is not empty`)
      }
    }
  }

  return {
    name: "base rootfs secret contract",
    ok: problems.length === 0,
    detail:
      problems.length === 0
        ? "credential placeholders and trusted bootstrap match scripts/gvisor/build-base-rootfs.sh"
        : `${problems.join("; ")} -- rebuild ${baseRootfsImage} with the current scripts/gvisor/build-base-rootfs.sh before starting this version.`,
  }
}

async function defaultInspectRootfsEntry(
  candidate: string,
): Promise<RootfsEntry | null> {
  try {
    const stats = await lstat(candidate)
    return {
      kind: stats.isSymbolicLink()
        ? "symlink"
        : stats.isFile()
          ? "file"
          : stats.isDirectory()
            ? "directory"
            : "other",
      size: stats.size,
      uid: stats.uid,
      mode: stats.mode & 0o7777,
    }
  } catch {
    return null
  }
}

function checkDnsConfigSource(
  readFile: (filePath: string) => string | null,
  resolveDns: typeof resolveDnsConfigSource,
): PreflightCheckResult {
  const source = resolveDns({ readFile })
  const content = readFile(source)

  if (content !== null && hasUsableNameserver(content)) {
    return {
      name: "DNS config source",
      ok: true,
      detail: `resolved to ${source}`,
    }
  }

  return {
    name: "DNS config source",
    ok: false,
    detail: `resolveDnsConfigSource() picked ${source}, but it has no usable non-loopback IPv4 nameserver -- network: sandbox DNS lookups will fail. See services/preview-worker/gvisor/dnsConfig.ts.`,
  }
}

/** Run only after stale disk reconciliation: otherwise orphan images that are
 * supposed to be reclaimed can prevent the probe allocation itself. */
export async function ensureSandboxDiskCapability(
  manager: SandboxDiskManager,
  probe: () => Promise<void> = () => probeDiskManager(manager),
): Promise<void> {
  try {
    await probe()
  } catch (error) {
    throw new Error(
      `Sandbox disk hard-quota capability probe failed: ${errorMessage(error)}`,
      { cause: error },
    )
  }
}

/** The running-job artifact reservation is meaningful only when publication
 * consumes the same filesystem whose bavail is checked by disk admission. */
export async function ensureProductionDiskLayout(
  options: ProductionDiskLayoutOptions,
): Promise<void> {
  const prepare =
    options.prepareDirectory ??
    (async (candidate: string) => {
      await mkdir(candidate, { recursive: true, mode: 0o700 })
    })
  const deviceFor =
    options.deviceFor ??
    (async (candidate: string) => (await stat(candidate)).dev)
  await prepare(options.bundlesRootDir)
  await prepare(options.artifactStorageDir)
  const [bundlesDevice, artifactsDevice] = await Promise.all([
    deviceFor(options.bundlesRootDir),
    deviceFor(options.artifactStorageDir),
  ])
  if (bundlesDevice !== artifactsDevice) {
    throw new Error(
      "PEEPHOLE_GVISOR_BUNDLES_DIR and PEEPHOLE_ARTIFACT_STORAGE_DIR must share a filesystem so artifact publication is covered by sandbox disk admission.",
    )
  }
}

/** Generated-secret capability gate. Production startup invokes this before
 * secret orphan reconciliation, worker construction, or any listener. It
 * proves both the host root's tmpfs backing and the trusted bootstrap's
 * presence. */
export async function ensureGeneratedSecretInjectionCapability(
  options: GeneratedSecretRootPreflightOptions,
): Promise<void> {
  await ensureMemoryBackedRoot(
    "Generated-secret",
    options.secretRootDir,
    options,
  )

  const bootstrap = nativePath.join(
    options.baseRootfsImage,
    "opt",
    "peephole",
    "secret-bootstrap.mjs",
  )
  const bootstrapStats = await lstat(bootstrap).catch(() => null)
  if (
    !bootstrapStats ||
    !bootstrapStats.isFile() ||
    bootstrapStats.isSymbolicLink()
  ) {
    throw new Error(
      "Trusted generated-secret bootstrap is missing from the base rootfs.",
    )
  }
}

/** M11 database-credential capability gate, run only when temporary
 * databases are enabled: the dedicated root must be a real tmpfs-backed
 * directory, mirroring the generated-secret root's requirements. */
export async function ensureDatabaseCredentialCapability(
  options: DatabaseCredentialRootPreflightOptions,
): Promise<void> {
  await ensureMemoryBackedRoot(
    "Database-credential",
    options.credentialRootDir,
    options,
  )
}

/** M12 capability gate, run only while `PEEPHOLE_USER_ENVIRONMENT=1`.
 * Deliberately NOT part of the always-on rootfs secret contract above, so
 * deploying this version on a pre-M12 rootfs keeps working while the
 * feature is off. When on, it proves a tmpfs-backed root, the third empty
 * root-owned placeholder, and an M12-aware bootstrap -- a pre-M12 bootstrap
 * would ignore the mounted file and start the backend without its values. */
export async function ensureUserEnvironmentCapability(
  options: UserEnvironmentPreflightOptions,
): Promise<void> {
  await ensureMemoryBackedRoot("User environment", options.rootDir, options)

  const inspect = options.inspectRootfsEntry ?? defaultInspectRootfsEntry
  const placeholder = await inspect(
    nativePath.join(options.baseRootfsImage, "run", "secrets", "user-env"),
  ).catch(() => null)
  if (
    !placeholder ||
    placeholder.kind !== "file" ||
    placeholder.uid !== 0 ||
    placeholder.mode !== 0o644 ||
    placeholder.size !== 0
  ) {
    throw new Error(
      "The base rootfs lacks the empty run/secrets/user-env placeholder -- rebuild it with the current scripts/gvisor/build-base-rootfs.sh before enabling PEEPHOLE_USER_ENVIRONMENT.",
    )
  }

  const readRootfsFile =
    options.readRootfsFile ??
    ((candidate: string) =>
      readFile(candidate, "utf8").catch(() => null as string | null))
  const bootstrap = await readRootfsFile(
    nativePath.join(
      options.baseRootfsImage,
      "opt",
      "peephole",
      "secret-bootstrap.mjs",
    ),
  )
  if (!bootstrap?.includes(SANDBOX_USER_ENVIRONMENT_BOOTSTRAP_FLAG)) {
    throw new Error(
      "The base rootfs bootstrap does not support user environment delivery -- rebuild it with the current scripts/gvisor/build-base-rootfs.sh before enabling PEEPHOLE_USER_ENVIRONMENT.",
    )
  }
}

async function ensureMemoryBackedRoot(
  label: string,
  configuredRoot: string,
  options: {
    processRunner?: ProcessRunner
    findmntBinaryPath?: string
    prepareDirectory?: (candidate: string) => Promise<void>
  },
): Promise<void> {
  if (!nativePath.isAbsolute(configuredRoot)) {
    throw new Error(`${label} root must be absolute.`)
  }
  const root = nativePath.resolve(configuredRoot)
  const prepare =
    options.prepareDirectory ??
    (async (candidate: string) => {
      await mkdir(candidate, { recursive: true, mode: 0o700 })
    })
  await prepare(root)
  const rootStats = await lstat(root)
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`${label} root must be a regular directory.`)
  }
  if ((await realpath(root)) !== root) {
    throw new Error(`${label} root must not traverse symlinks.`)
  }
  await assertTmpfsFilesystem(
    root,
    options.processRunner,
    options.findmntBinaryPath,
  )
}

async function probeDiskManager(manager: SandboxDiskManager): Promise<void> {
  const allocation = await manager.createAllocation({ expectedOutsideBytes: 0 })
  try {
    await manager.updateReservedOutsideBytes(allocation, 0)
    await manager.mountWorkspace(allocation, { remainingOutsideBytes: 0 })
    await manager.destroyAllocation(allocation)
  } catch (error) {
    try {
      await manager.destroyAllocation(allocation)
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Disk capability probe failed and cleanup was incomplete.",
        { cause: cleanupError },
      )
    }
    throw error
  }
}

function defaultReadFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8")
  } catch {
    return null
  }
}

async function defaultPathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate)
    return true
  } catch {
    return false
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
