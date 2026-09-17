const MAX_PATH_LENGTH = 400
const MAX_PATH_SEGMENTS = 8
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/

/**
 * A conservative, deny-by-default charset for a single repository path
 * segment. This is deliberately narrower than every valid GitHub directory
 * name: structure detection only ever probes a small, capability-driven set
 * of conventional or explicitly declared workspace paths, so rejecting an
 * unusual segment only means Peephole skips that candidate, not that it
 * mishandles it.
 */
export function isRepositorySafePathSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    SAFE_SEGMENT_PATTERN.test(segment)
  )
}

/**
 * Validates a repository-relative directory path used with the GitHub
 * contents API. The empty string means the repository root. Rejects
 * absolute paths, `..` traversal, backslash traversal, and empty/malformed
 * segments.
 */
export function isRepositoryRelativeDirectoryPath(path: string): boolean {
  if (path === "") return true
  if (path.length > MAX_PATH_LENGTH) return false
  if (path.startsWith("/") || path.endsWith("/") || path.includes("\\")) {
    return false
  }

  const segments = path.split("/")

  return (
    segments.length <= MAX_PATH_SEGMENTS &&
    segments.every(isRepositorySafePathSegment)
  )
}

export function joinRepositoryPath(...segments: readonly string[]): string {
  return segments.filter((segment) => segment.length > 0).join("/")
}
