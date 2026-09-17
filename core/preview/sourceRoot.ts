import { isRepositoryRelativeDirectoryPath } from "../github/repositoryPath"

export const ROOT_PREVIEW_SOURCE = "."

/**
 * Validates an execution target, not a URL or encoded path. Values are used
 * exactly as supplied: percent-encoded traversal is not decoded or accepted.
 */
export function isSafePreviewSourceRoot(value: unknown): value is string {
  return (
    value === ROOT_PREVIEW_SOURCE ||
    (typeof value === "string" &&
      value.length > 0 &&
      isRepositoryRelativeDirectoryPath(value))
  )
}

export function previewTargetKey(
  repositoryId: number,
  commitSha: string,
  sourceRoot: string,
): string {
  return `${repositoryId}:${commitSha.toLowerCase()}:${sourceRoot}`
}
