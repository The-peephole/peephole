import type { ArchiveEntry, FetchedArchive, ResolvedOutput } from "../../types/runner"

export interface ArchiveLimits {
  maxCompressedBytes: number
  maxExpandedBytes: number
  maxFileCount: number
  maxEntryPathLength: number
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxCompressedBytes: 50 * 1024 * 1024,
  maxExpandedBytes: 250 * 1024 * 1024,
  maxFileCount: 20_000,
  maxEntryPathLength: 4096,
}

export interface OutputLimits {
  maxTotalBytes: number
  maxFileCount: number
  maxEntryPathLength: number
}

export const DEFAULT_OUTPUT_LIMITS: OutputLimits = {
  maxTotalBytes: 100 * 1024 * 1024,
  maxFileCount: 20_000,
  maxEntryPathLength: 4096,
}

export class ArchiveRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ArchiveRejectedError"
  }
}

export class OutputRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OutputRejectedError"
  }
}

export function validateFetchedArchive(
  archive: FetchedArchive,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): void {
  if (archive.compressedBytes > limits.maxCompressedBytes) {
    throw new ArchiveRejectedError(
      "The source archive exceeds the compressed size limit.",
    )
  }

  if (archive.entries.length > limits.maxFileCount) {
    throw new ArchiveRejectedError(
      "The source archive exceeds the file-count limit.",
    )
  }

  let expandedBytes = 0

  for (const entry of archive.entries) {
    assertSafeEntry(entry, limits.maxEntryPathLength, ArchiveRejectedError)
    expandedBytes += entry.bytes
  }

  if (expandedBytes > limits.maxExpandedBytes) {
    throw new ArchiveRejectedError(
      "The source archive exceeds the expanded size limit.",
    )
  }
}

export function validateResolvedOutput(
  output: ResolvedOutput,
  limits: OutputLimits = DEFAULT_OUTPUT_LIMITS,
): void {
  if (output.entries.length === 0) {
    throw new OutputRejectedError("The build produced no output files.")
  }

  if (output.entries.length > limits.maxFileCount) {
    throw new OutputRejectedError("The build output exceeds the file-count limit.")
  }

  let totalBytes = 0

  for (const entry of output.entries) {
    assertSafeEntry(entry, limits.maxEntryPathLength, OutputRejectedError)
    totalBytes += entry.bytes
  }

  if (totalBytes > limits.maxTotalBytes) {
    throw new OutputRejectedError("The build output exceeds the total size limit.")
  }
}

function assertSafeEntry(
  entry: ArchiveEntry,
  maxPathLength: number,
  ErrorType: new (message: string) => Error,
): void {
  if (entry.isSymlink) {
    throw new ErrorType(`Symlinked entries are not permitted: ${entry.path}`)
  }

  if (entry.bytes < 0) {
    throw new ErrorType(`Entry byte size is invalid: ${entry.path}`)
  }

  if (!isSafeEntryPath(entry.path, maxPathLength)) {
    throw new ErrorType(`Entry path escapes the workspace root: ${entry.path}`)
  }
}

export function isSafeEntryPath(path: string, maxLength: number): boolean {
  return (
    path.length > 0 &&
    path.length <= maxLength &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((segment) => segment === "" || segment === "..")
  )
}
