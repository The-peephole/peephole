import {
  lstat as fsLstat,
  readFile as fsReadFile,
  rm as fsRm,
} from "node:fs/promises"
import path from "node:path"

import { NodeProcessRunner } from "../../services/preview-worker/gvisor/nodeProcessRunner"
import type {
  ProcessRunner,
  ProcessRunResult,
} from "../../services/preview-worker/gvisor/processRunner"
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
 * The only four things the exact `<runscRootDir>/null-netns` path can ever
 * be, from this module's point of view. `"unknown"` is deliberately distinct
 * from `"absent"`/`"present-non-nsfs"` -- an inspection FAILURE (an lstat
 * error other than "does not exist," an unreadable or unparseable
 * `/proc/self/mountinfo`) must never be treated the same as a successful
 * inspection that positively proves the path is safe to hand to a normal
 * `rm`. Conflating those two states is exactly the defect this type exists
 * to make structurally impossible.
 */
export type NullNetnsClassification =
  | { kind: "absent" }
  | { kind: "exact-nsfs-mount"; path: string }
  | { kind: "present-non-nsfs" }
  /** Successfully lstat'd and is not a symlink target we'd expect a normal
   * file/mount to be, but IS itself a symlink -- refused rather than
   * assumed safe, since a symlink sitting exactly where the trusted kernel
   * mount should be is anomalous. */
  | { kind: "symlink" }
  | { kind: "unknown"; reason: string }

/**
 * Parses `/proc/self/mountinfo` (see proc(5)) into `{mountPoint, fsType}`
 * pairs, skipping any line that does not match the expected shape. Mirrors
 * the decoding already used for the same file format in
 * scripts/production-smoke/host.ts's `parseMountInfo`/`decodeMountPath`.
 * Deliberately lenient at this layer (a general-purpose parsing utility);
 * `classifyNullNetns` below applies its own stricter completeness check
 * before trusting the result.
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

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
}

/**
 * Proves -- or explicitly refuses to assume -- exactly what
 * `<runscRootDir>/null-netns` currently is. Every branch is a positive
 * determination except `"unknown"`, which is returned whenever the
 * classification cannot be trusted: an lstat failure that isn't "the path
 * doesn't exist," a mount-information read failure, or mount information
 * that doesn't fully parse (any non-blank line this module's own parser
 * cannot interpret makes the whole read untrustworthy for this purpose,
 * even if other lines look fine). Never returns or logs the raw contents of
 * anything it reads.
 */
export async function classifyNullNetns(
  runscRootDir: string,
  options: RealRunscStateInspectionOptions = {},
): Promise<NullNetnsClassification> {
  const candidate = path.resolve(runscRootDir, NULL_NETNS_FILENAME)
  const doLstat = options.lstat ?? ((p: string) => fsLstat(p))
  const readMountInfo =
    options.readMountInfo ?? (() => fsReadFile("/proc/self/mountinfo", "utf8"))

  let stats: { isSymbolicLink(): boolean }
  try {
    stats = await doLstat(candidate)
  } catch (error) {
    if (isEnoent(error)) return { kind: "absent" }
    return {
      kind: "unknown",
      reason: "Could not stat the candidate null-netns path.",
    }
  }
  if (stats.isSymbolicLink()) return { kind: "symlink" }

  let contents: string
  try {
    contents = await readMountInfo()
  } catch {
    return {
      kind: "unknown",
      reason:
        "Could not read mount information to classify the candidate path.",
    }
  }

  const nonBlankLines = contents
    .split("\n")
    .filter((line) => line.trim().length > 0)
  const entries = parseMountInfo(contents)
  if (nonBlankLines.length === 0 || entries.length !== nonBlankLines.length) {
    // Either genuinely empty (never true of a real /proc/self/mountinfo) or
    // at least one line this parser could not interpret -- either way, not
    // a basis anything else here may treat as a proven negative.
    return {
      kind: "unknown",
      reason: "Mount information could not be reliably parsed.",
    }
  }

  const isExactNsfsMount = entries.some(
    (entry) => entry.mountPoint === candidate && entry.fsType === "nsfs",
  )
  return isExactNsfsMount
    ? { kind: "exact-nsfs-mount", path: candidate }
    : { kind: "present-non-nsfs" }
}

/**
 * The M10-C4B-safe replacement for calling `scanRegularFilesForRawValue`
 * directly against a runsc `--root` state directory. Excludes exactly the
 * one path `classifyNullNetns` proves is a kernel namespace mount; every
 * other classification (including `"unknown"`) adds no exclusion, leaving
 * the generic, still-fully-fail-closed scanner to open and read it -- and
 * fail closed if it genuinely cannot.
 */
export async function scanRunscStateForRawValue(
  runscRootDir: string,
  rawValue: string,
  options: RealRunscStateInspectionOptions & {
    maxEntries?: number
    maxBytes?: number
  } = {},
): Promise<RunscStateScanResult> {
  const classification = await classifyNullNetns(runscRootDir, options)
  const structuralExclusions =
    classification.kind === "exact-nsfs-mount"
      ? new Set([classification.path])
      : new Set<string>()

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
 * pass a directory created exclusively for one test run.
 *
 * Repeatedly classifies the exact `null-netns` candidate (bounded): an
 * `"absent"` or `"present-non-nsfs"` result means the caller's normal `rm`
 * is safe; a `"symlink"` or `"unknown"` result means this function refuses
 * to guess and returns `{ok: false}` so the caller preserves the directory
 * instead of deleting it. Only `"exact-nsfs-mount"` triggers an unmount
 * attempt (never a wildcard, never a recursive unmount of any ancestor) --
 * and success is judged solely by re-classifying afterward, never by the
 * unmount command's own reported exit status, since gVisor may stack more
 * than one bind mount at the same path.
 */
export async function reconcileDedicatedRunscStateForCleanup(
  dedicatedRunscRootDir: string,
  options: RealRunscStateInspectionOptions = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const processRunner = options.processRunner ?? new NodeProcessRunner()
  const umountBinaryPath = options.umountBinaryPath ?? "umount"
  let lastAttemptReportedFailure = false

  for (let attempt = 0; attempt < MAX_UNMOUNT_ATTEMPTS; attempt += 1) {
    const classification = await classifyNullNetns(
      dedicatedRunscRootDir,
      options,
    )

    if (
      classification.kind === "absent" ||
      classification.kind === "present-non-nsfs"
    ) {
      return { ok: true }
    }
    if (classification.kind === "symlink") {
      return {
        ok: false,
        reason:
          "Refusing to reconcile: the dedicated runsc root's null-netns path is unexpectedly a symlink.",
      }
    }
    if (classification.kind === "unknown") {
      return {
        ok: false,
        reason: `Could not reliably classify the dedicated runsc root's null-netns path (${classification.reason}).`,
      }
    }

    // classification.kind === "exact-nsfs-mount": attempt exactly one
    // unmount of exactly this proven path. Whether this reports success is
    // never treated as proof by itself -- the next loop iteration's fresh
    // classification is the only thing that actually decides whether the
    // mount is gone. It is still inspected, so a command that fails
    // structurally (nonzero exit, timeout, thrown error) is distinguishable
    // in the final failure reason from one that reported success yet left
    // the mount in place.
    let result: ProcessRunResult | undefined
    try {
      result = await processRunner.run(
        umountBinaryPath,
        [classification.path],
        { timeoutMs: 10_000 },
      )
    } catch {
      result = undefined
    }
    lastAttemptReportedFailure =
      result === undefined || result.exitCode !== 0 || result.timedOut
  }

  return {
    ok: false,
    reason: lastAttemptReportedFailure
      ? "The dedicated runsc root's null-netns mount did not clear: the umount command itself did not report success within the bounded retry budget."
      : "The dedicated runsc root's null-netns mount did not clear even though the umount command reported success, within the bounded retry budget.",
  }
}

/**
 * The exact "reconcile, then remove only if reconciled" decision
 * `tests/realBackendRuntime.test.ts`'s shared `afterEach` applies to a
 * dedicated-runsc-root environment, extracted here so it is unit-testable
 * without the real-gVisor-gated describe block. Never removes `root` when
 * reconciliation could not prove the dedicated runsc state was safe to
 * hand off -- the evidence directory is preserved instead.
 */
export async function removeDedicatedTestRootIfReconciled(
  root: string,
  runscRootDir: string,
  options: RealRunscStateInspectionOptions & {
    rm?: (targetPath: string) => Promise<void>
  } = {},
): Promise<{ removed: true } | { removed: false; reason: string }> {
  const reconciled = await reconcileDedicatedRunscStateForCleanup(
    runscRootDir,
    options,
  )
  if (!reconciled.ok) {
    return { removed: false, reason: reconciled.reason }
  }
  const doRm =
    options.rm ??
    ((targetPath: string) => fsRm(targetPath, { recursive: true, force: true }))
  await doRm(root)
  return { removed: true }
}
