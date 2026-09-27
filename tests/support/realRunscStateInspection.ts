import { lstat as fsLstat, readFile as fsReadFile } from "node:fs/promises"
import path from "node:path"

import { NodeProcessRunner } from "../../services/preview-worker/gvisor/nodeProcessRunner"
import type { ProcessRunner } from "../../services/preview-worker/gvisor/processRunner"
import {
  scanRegularFilesForRawValue,
  type BoundedRawValueScanResult,
  type ScannedDirectory,
} from "./boundedRawValueScanner"

/**
 * The exact, fixed filename real runsc creates directly under its own
 * `--root` state directory as a bind-mounted `nsfs` reference to a shared
 * "null" network namespace (used for `--network=none` containers). Upstream
 * gVisor names this file literally `null-netns`. It is never data -- it is
 * a kernel namespace handle -- so it can never contain a raw secret value,
 * but it also cannot be opened and read like a regular file. This module is
 * the ONLY place allowed to decide that this one exact, structurally-proven
 * path may be excluded from a raw-value scan; it never accepts a name
 * pattern or an arbitrary predicate, and it never excludes anything else.
 */
export const NULL_NETNS_FILENAME = "null-netns"

const MAX_UNMOUNT_ATTEMPTS = 8

export interface MountInfoEntry {
  mountPoint: string
  fsType: string
}

export interface RealRunscStateInspectionOptions {
  readMountInfo?: () => Promise<string>
  /** Superset of what both this module (`isSymbolicLink()`) and the
   * forwarded generic scan (`size`) need, so one injected fake can satisfy
   * both -- exactly what the real `fs.lstat` naturally returns. */
  lstat?: (
    targetPath: string,
  ) => Promise<{ size: number; isSymbolicLink(): boolean }>
  opendir?: (targetPath: string) => Promise<ScannedDirectory>
  readFile?: (targetPath: string) => Promise<Buffer>
  processRunner?: ProcessRunner
  umountBinaryPath?: string
}

export interface RunscStateScanResult extends Omit<
  BoundedRawValueScanResult,
  "skippedStructuralExclusions"
> {
  /** Renamed from the generic scanner's `skippedStructuralExclusions` at
   * this runsc-specific boundary, where every exclusion is known to be a
   * proven kernel namespace mount and nothing else. */
  skippedKernelNamespaceMounts: number
}

/**
 * Parses `/proc/self/mountinfo` (see proc(5)) into `{mountPoint, fsType}`
 * pairs. Mirrors the decoding already used for the same file format in
 * scripts/production-smoke/host.ts's `parseMountInfo`/`decodeMountPath`.
 */
export function parseMountInfo(contents: string): MountInfoEntry[] {
  const entries: MountInfoEntry[] = []
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue
    const fields = line.split(" ")
    const dashIndex = fields.indexOf("-")
    const mountPointField = fields[4]
    const fsTypeField = dashIndex === -1 ? undefined : fields[dashIndex + 1]
    if (mountPointField === undefined || fsTypeField === undefined) continue
    entries.push({
      mountPoint: decodeMountPath(mountPointField),
      fsType: fsTypeField,
    })
  }
  return entries
}

function decodeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  )
}

/**
 * Proves -- or refuses to assume -- that `<runscRootDir>/null-netns` is
 * genuinely a kernel namespace mount, never by name alone. Returns a set
 * containing exactly that one path only when ALL of the following hold:
 * the path exists, is not a symlink, and `/proc/self/mountinfo` shows it as
 * an exact mount point (not merely contained within one) whose filesystem
 * type is `nsfs`. Any failure to prove this -- missing path, symlink,
 * unreadable mountinfo, wrong fstype, or a mount point that only contains
 * (rather than exactly is) the candidate -- returns an empty set, which
 * leaves the candidate to the normal fail-closed scan path.
 */
export async function findExactNullNetnsMount(
  runscRootDir: string,
  options: RealRunscStateInspectionOptions = {},
): Promise<ReadonlySet<string>> {
  const candidate = path.resolve(runscRootDir, NULL_NETNS_FILENAME)
  const doLstat = options.lstat ?? ((p: string) => fsLstat(p))
  const readMountInfo =
    options.readMountInfo ?? (() => fsReadFile("/proc/self/mountinfo", "utf8"))

  let stats: { isSymbolicLink(): boolean }
  try {
    stats = await doLstat(candidate)
  } catch {
    return new Set()
  }
  if (stats.isSymbolicLink()) return new Set()

  let contents: string
  try {
    contents = await readMountInfo()
  } catch {
    return new Set()
  }

  const isExactNsfsMount = parseMountInfo(contents).some(
    (entry) => entry.mountPoint === candidate && entry.fsType === "nsfs",
  )
  return isExactNsfsMount ? new Set([candidate]) : new Set()
}

/**
 * The M10-C4B-safe replacement for calling `scanRegularFilesForRawValue`
 * directly against a runsc `--root` state directory. Computes the one
 * proven kernel-namespace-mount exclusion (if any) and forwards it to the
 * generic, still-fully-fail-closed scanner -- every other unreadable path,
 * bound overrun, or open/read failure still throws exactly as before.
 */
export async function scanRunscStateForRawValue(
  runscRootDir: string,
  rawValue: string,
  options: RealRunscStateInspectionOptions & {
    maxEntries?: number
    maxBytes?: number
  } = {},
): Promise<RunscStateScanResult> {
  const structuralExclusions = await findExactNullNetnsMount(
    runscRootDir,
    options,
  )
  const result = await scanRegularFilesForRawValue(runscRootDir, rawValue, {
    maxEntries: options.maxEntries,
    maxBytes: options.maxBytes,
    opendir: options.opendir,
    lstat: options.lstat,
    readFile: options.readFile,
    structuralExclusions,
  })
  const { skippedStructuralExclusions, ...rest } = result
  return { ...rest, skippedKernelNamespaceMounts: skippedStructuralExclusions }
}

/**
 * Prepares a dedicated, test-owned runsc `--root` directory for removal.
 * Never touches a shared/production runsc root -- callers must only ever
 * pass a directory created exclusively for one test run. If a genuine
 * `null-netns` nsfs mount is found there, this unmounts exactly that one
 * path (never a wildcard, never a recursive unmount of any ancestor),
 * looping a bounded number of times since gVisor may stack more than one
 * bind mount at the same path. Returns `{ok: false}` -- never throws,
 * never deletes anything itself -- whenever it cannot prove the path is
 * safe to hand off to the caller's own directory removal: a symlink where
 * the mount should be, or a mount that would not clear within the bounded
 * retry budget. The caller must treat `{ok: false}` as "preserve this
 * directory," not as license to force-remove it anyway.
 */
export async function reconcileDedicatedRunscStateForCleanup(
  dedicatedRunscRootDir: string,
  options: RealRunscStateInspectionOptions = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const candidate = path.resolve(dedicatedRunscRootDir, NULL_NETNS_FILENAME)
  const doLstat = options.lstat ?? ((p: string) => fsLstat(p))
  const processRunner = options.processRunner ?? new NodeProcessRunner()
  const umountBinaryPath = options.umountBinaryPath ?? "umount"

  for (let attempt = 0; attempt < MAX_UNMOUNT_ATTEMPTS; attempt += 1) {
    let stats: { isSymbolicLink(): boolean }
    try {
      stats = await doLstat(candidate)
    } catch {
      return { ok: true }
    }
    if (stats.isSymbolicLink()) {
      return {
        ok: false,
        reason:
          "Refusing to reconcile: the dedicated runsc root's null-netns path is unexpectedly a symlink.",
      }
    }

    const exclusions = await findExactNullNetnsMount(
      dedicatedRunscRootDir,
      options,
    )
    if (exclusions.size === 0) {
      // Exists but is not a proven nsfs mount -- not this function's
      // concern; leave it for the caller's normal directory removal.
      return { ok: true }
    }

    try {
      await processRunner.run(umountBinaryPath, [candidate], {
        timeoutMs: 10_000,
      })
    } catch {
      // Keep retrying within the bounded budget below.
    }
  }

  const stillMounted = await findExactNullNetnsMount(
    dedicatedRunscRootDir,
    options,
  )
  if (stillMounted.size > 0) {
    return {
      ok: false,
      reason:
        "The dedicated runsc root's null-netns mount did not clear within the bounded unmount retry budget.",
    }
  }
  return { ok: true }
}
