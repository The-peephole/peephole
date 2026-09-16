import type {
  RepositoryIdentity,
  RepositoryRefSelection,
  RepositoryRevisionTarget,
} from "../../types/repository"

const OWNER_PATTERN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i
const REPOSITORY_PATTERN = /^[a-z\d_.-]+$/i
const FORBIDDEN_BRANCH_CHARACTERS = new Set([
  "~",
  "^",
  ":",
  "?",
  "*",
  "[",
  "\\",
])
const MAX_BRANCH_NAME_LENGTH = 255

export const DEFAULT_REPOSITORY_REF: RepositoryRefSelection = {
  kind: "default",
}

export function isRepositoryIdentity(
  value: unknown,
): value is RepositoryIdentity {
  return (
    isObject(value) &&
    typeof value.owner === "string" &&
    OWNER_PATTERN.test(value.owner) &&
    typeof value.repo === "string" &&
    REPOSITORY_PATTERN.test(value.repo)
  )
}

export function isRepositoryBranchName(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_BRANCH_NAME_LENGTH ||
    value === "@" ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("//") ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return (
        codePoint <= 0x20 ||
        codePoint === 0x7f ||
        FORBIDDEN_BRANCH_CHARACTERS.has(character)
      )
    })
  ) {
    return false
  }

  return value
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        !segment.startsWith(".") &&
        !segment.endsWith(".lock"),
    )
}

export function isRepositoryRefSelection(
  value: unknown,
): value is RepositoryRefSelection {
  return (
    isObject(value) &&
    (value.kind === "default" ||
      (value.kind === "branch" && isRepositoryBranchName(value.name)))
  )
}

export function isRepositoryRevisionTarget(
  value: unknown,
): value is RepositoryRevisionTarget {
  return (
    isObject(value) &&
    isRepositoryIdentity(value.repository) &&
    isRepositoryRefSelection(value.ref)
  )
}

export function getRepositoryRefCacheKey(
  repositoryKey: string,
  ref: RepositoryRefSelection,
): string {
  return ref.kind === "default"
    ? `${repositoryKey}:default`
    : `${repositoryKey}:branch:${ref.name}`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
