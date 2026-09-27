import {
  lstat as fsLstat,
  opendir as fsOpendir,
  readFile as fsReadFile,
} from "node:fs/promises"
import path from "node:path"

const DEFAULT_MAX_ENTRIES = 2_000
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

/**
 * Thrown whenever a complete, bounded inspection cannot be proven -- an
 * unreadable directory/file, a bound that would be exceeded, or a
 * post-read size mismatch. Never carries file contents, environment dumps,
 * or the value being searched for; only a fixed, generic description.
 */
export class BoundedRawValueScanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BoundedRawValueScanError"
  }
}

/** The minimal directory-entry shape the scanner needs -- structurally
 * satisfied by Node's real `Dirent`, and easy to fake in portable tests. */
export interface ScannedDirEntry {
  name: string
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

/** The minimal directory-handle shape the scanner needs -- structurally
 * satisfied by Node's real `Dir` (an `AsyncIterable<Dirent>` with
 * `close()`), and easy to fake in portable tests. */
export interface ScannedDirectory extends AsyncIterable<ScannedDirEntry> {
  close(): Promise<void>
}

export interface BoundedRawValueScanOptions {
  /** Hard cap on the total number of directory entries examined (files,
   * directories, and skipped non-regular/symlink entries alike) across the
   * whole traversal. Reaching it without finishing throws rather than
   * returning a partial result -- this is what makes a directory subtree
   * with no files (or one deeper than expected) fail closed instead of
   * silently under-scanning. */
  maxEntries?: number
  /** Hard cap on cumulative regular-file bytes read. Checked against a
   * file's stat size *before* it is read, and re-checked against the
   * actual bytes read afterward, so a file that would exceed the remaining
   * budget is never partially read and then reported clean. */
  maxBytes?: number
  opendir?: (targetPath: string) => Promise<ScannedDirectory>
  lstat?: (targetPath: string) => Promise<{ size: number }>
  readFile?: (targetPath: string) => Promise<Buffer>
  /** Exact, absolute, already-canonicalized paths this scan may skip
   * without opening or reading -- never a predicate, never a name pattern.
   * This scanner performs no classification of its own: a caller (such as
   * realRunscStateInspection.ts) must have already proven, out of band,
   * that each path here is not a data-bearing regular file (e.g. a genuine
   * kernel namespace mount confirmed against `/proc/self/mountinfo`) before
   * adding it. An excluded entry still counts toward the entry bound and
   * toward `skippedStructuralExclusions`; nothing here weakens fail-closed
   * behavior for any path not in this exact set. */
  structuralExclusions?: ReadonlySet<string>
}

export interface BoundedRawValueScanResult {
  found: boolean
  scannedEntries: number
  scannedFiles: number
  scannedBytes: number
  /** Entries matched against `structuralExclusions` and skipped without
   * being opened or read. Distinct from `scannedFiles` -- an excluded entry
   * is never counted as scanned, since its contents were never inspected. */
  skippedStructuralExclusions: number
  /** Always `true` when this function returns normally -- a scan that
   * cannot be completed within its bounds throws instead of returning
   * `complete: false`, so there is no partial-result shape a caller could
   * mistakenly treat as a clean scan. */
  complete: true
}

/**
 * Fail-closed, bounded scan of every regular file under `rootDir` for one
 * exact raw value. A caller may treat a normal return as proof that the
 * *entire* directory tree, within the configured bounds, was inspected and
 * did not contain the value -- every failure mode that would otherwise
 * leave part of the tree uninspected (an unreadable directory or file, a
 * bound that would be exceeded, a file that grew between stat and read)
 * throws a `BoundedRawValueScanError` instead of silently skipping,
 * truncating, or stopping early. Symlinks are never followed; devices,
 * sockets, and FIFOs are ignored (not read, but still counted against the
 * entry bound). Never returns, logs, or embeds the raw value, file
 * contents, or an environment dump in any thrown error.
 */
export async function scanRegularFilesForRawValue(
  rootDir: string,
  rawValue: string,
  options: BoundedRawValueScanOptions = {},
): Promise<BoundedRawValueScanResult> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const doOpendir = options.opendir ?? ((p: string) => fsOpendir(p))
  const doLstat = options.lstat ?? ((p: string) => fsLstat(p))
  const doReadFile = options.readFile ?? ((p: string) => fsReadFile(p))
  const structuralExclusions = options.structuralExclusions ?? new Set<string>()

  const needle = Buffer.from(rawValue, "utf8")
  let scannedEntries = 0
  let scannedFiles = 0
  let scannedBytes = 0
  let skippedStructuralExclusions = 0
  let found = false
  const pending: string[] = [rootDir]

  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) continue

    let directory: ScannedDirectory
    try {
      directory = await doOpendir(current)
    } catch {
      throw new BoundedRawValueScanError(
        "Bounded raw-value scan could not open a directory under the dedicated test-owned root; inspection is incomplete.",
      )
    }
    try {
      for await (const entry of directory) {
        scannedEntries += 1
        if (scannedEntries > maxEntries) {
          throw new BoundedRawValueScanError(
            "Bounded raw-value scan exceeded its configured entry bound before completing; inspection is incomplete.",
          )
        }

        if (entry.isSymbolicLink()) continue
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          pending.push(full)
          continue
        }
        if (!entry.isFile()) continue

        // Only ever an exact-path match against a set the caller populated
        // out of band with already-proven, non-data-bearing paths (e.g. a
        // confirmed kernel namespace mount) -- never a name or pattern
        // check, and never a reason to skip anything else under this root.
        if (structuralExclusions.has(path.resolve(full))) {
          skippedStructuralExclusions += 1
          continue
        }

        let size: number
        try {
          size = (await doLstat(full)).size
        } catch {
          throw new BoundedRawValueScanError(
            "Bounded raw-value scan could not stat a regular file under the dedicated test-owned root; inspection is incomplete.",
          )
        }
        if (scannedBytes + size > maxBytes) {
          throw new BoundedRawValueScanError(
            "Bounded raw-value scan exceeded its configured byte bound before completing; inspection is incomplete.",
          )
        }

        let contents: Buffer
        try {
          contents = await doReadFile(full)
        } catch {
          throw new BoundedRawValueScanError(
            "Bounded raw-value scan could not read a regular file under the dedicated test-owned root; inspection is incomplete.",
          )
        }
        // Defensive re-check: a file that grew between stat and read must
        // still never be reported as fully, safely inspected.
        if (scannedBytes + contents.byteLength > maxBytes) {
          throw new BoundedRawValueScanError(
            "Bounded raw-value scan exceeded its configured byte bound while reading; inspection is incomplete.",
          )
        }

        scannedFiles += 1
        scannedBytes += contents.byteLength
        if (contents.includes(needle)) found = true
      }
    } finally {
      await directory.close().catch(() => undefined)
    }
  }

  return {
    found,
    scannedEntries,
    scannedFiles,
    scannedBytes,
    skippedStructuralExclusions,
    complete: true,
  }
}
