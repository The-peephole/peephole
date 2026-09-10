import { readFileSync } from "node:fs"
import { mkdir, stat } from "node:fs/promises"
import path from "node:path/posix"

import {
  hasUsableNameserver,
  resolveDnsConfigSource,
} from "../preview-worker/gvisor/dnsConfig"
import { NodeProcessRunner } from "../preview-worker/gvisor/nodeProcessRunner"
import type { ProcessRunner } from "../preview-worker/gvisor/processRunner"
import { type SandboxDiskManager } from "../preview-worker/gvisor/sandboxDisk"

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
