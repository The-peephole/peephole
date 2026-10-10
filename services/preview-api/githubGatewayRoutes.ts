import { isRepositoryRelativeDirectoryPath } from "../../core/github/repositoryPath"
import {
  isRepositoryBranchName,
  isRepositoryIdentity,
} from "../../core/github/repositoryRef"
import {
  MAX_DEPLOYMENT_STATUSES_PER_PAGE,
  MAX_REPOSITORY_BRANCHES,
  MAX_REPOSITORY_DEPLOYMENTS,
} from "../../core/github/client"

const MAX_RAW_PATH_LENGTH = 2_048
const MAX_REPOSITORY_NAME_LENGTH = 100
const COMMIT_SHA_PATTERN = /^[a-f\d]{40}$/

interface RepositoryTarget {
  owner: string
  repo: string
}

/**
 * The only GitHub REST reads the gateway performs -- exactly the extension
 * `GitHubClient` operations, each with every parameter re-validated. The
 * gateway rebuilds the upstream URL from these fields; the raw client path is
 * never forwarded.
 */
export type GitHubGatewayOperation =
  | ({ kind: "repository" } & RepositoryTarget)
  | ({ kind: "branch"; branch: string } & RepositoryTarget)
  | ({ kind: "branches" } & RepositoryTarget)
  | ({ kind: "contents"; path: string; ref: string } & RepositoryTarget)
  | ({ kind: "deployments" } & RepositoryTarget)
  | ({ kind: "deployment-statuses"; deploymentId: number } & RepositoryTarget)

/**
 * Parses the GitHub REST path (with query) that the extension's
 * `GitHubClient` would have requested. Returns null for anything outside the
 * fixed operation set. The raw string is split by hand rather than through
 * `URL`, whose dot-segment normalization (including `%2e%2e`) would rewrite
 * a path before it could be rejected.
 */
export function parseGitHubGatewayPath(
  raw: unknown,
): GitHubGatewayOperation | null {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > MAX_RAW_PATH_LENGTH ||
    !raw.startsWith("/repos/") ||
    /[\s#\\]/u.test(raw) ||
    hasControlCharacter(raw)
  ) {
    return null
  }

  const queryIndex = raw.indexOf("?")
  const rawPath = queryIndex === -1 ? raw : raw.slice(0, queryIndex)
  const rawQuery = queryIndex === -1 ? null : raw.slice(queryIndex + 1)
  const encodedSegments = rawPath.split("/").slice(1)
  if (encodedSegments.some((segment) => segment.length === 0)) return null

  const segments = encodedSegments.map(decodeSegment)
  if (segments.some((segment) => segment === null)) return null
  const [, owner, repo, ...rest] = segments as string[]
  if (
    owner === undefined ||
    repo === undefined ||
    !isRepositoryIdentity({ owner, repo }) ||
    repo === "." ||
    repo === ".." ||
    repo.length > MAX_REPOSITORY_NAME_LENGTH
  ) {
    return null
  }
  const target = { owner, repo }
  const query = parseQuery(rawQuery)
  if (query === null) return null

  if (rest.length === 0) {
    return hasExactQuery(query, {}) ? { kind: "repository", ...target } : null
  }

  if (rest[0] === "branches") {
    if (rest.length === 1) {
      return hasExactQuery(query, {
        per_page: String(MAX_REPOSITORY_BRANCHES),
        page: "1",
      })
        ? { kind: "branches", ...target }
        : null
    }
    const branch = rest[1]
    return rest.length === 2 &&
      hasExactQuery(query, {}) &&
      isRepositoryBranchName(branch)
      ? { kind: "branch", branch, ...target }
      : null
  }

  if (rest[0] === "contents") {
    const ref = query.get("ref")
    // A decoded segment may itself contain "/" because the client encodes a
    // whole file path as one segment; validate the joined path as a whole.
    const path = rest.slice(1).join("/")
    return query.size === 1 &&
      ref !== undefined &&
      COMMIT_SHA_PATTERN.test(ref) &&
      isRepositoryRelativeDirectoryPath(path)
      ? { kind: "contents", path, ref, ...target }
      : null
  }

  if (rest[0] === "deployments") {
    if (rest.length === 1) {
      return hasExactQuery(query, {
        per_page: String(MAX_REPOSITORY_DEPLOYMENTS),
        page: "1",
      })
        ? { kind: "deployments", ...target }
        : null
    }
    const deploymentId = Number(rest[1])
    return rest.length === 3 &&
      rest[2] === "statuses" &&
      /^[1-9]\d{0,15}$/.test(rest[1] ?? "") &&
      Number.isSafeInteger(deploymentId) &&
      hasExactQuery(query, {
        per_page: String(MAX_DEPLOYMENT_STATUSES_PER_PAGE),
        page: "1",
      })
      ? { kind: "deployment-statuses", deploymentId, ...target }
      : null
  }

  return null
}

/** Rebuilds the canonical upstream path from validated fields only. */
export function toGitHubUpstreamPath(
  operation: GitHubGatewayOperation,
): string {
  const repositoryPath = `/repos/${encodeURIComponent(operation.owner)}/${encodeURIComponent(operation.repo)}`
  switch (operation.kind) {
    case "repository":
      return repositoryPath
    case "branch":
      return `${repositoryPath}/branches/${encodeURIComponent(operation.branch)}`
    case "branches":
      return `${repositoryPath}/branches?per_page=${MAX_REPOSITORY_BRANCHES}&page=1`
    case "contents": {
      const suffix =
        operation.path === ""
          ? ""
          : `/${operation.path.split("/").map(encodeURIComponent).join("/")}`
      return `${repositoryPath}/contents${suffix}?ref=${operation.ref}`
    }
    case "deployments":
      return `${repositoryPath}/deployments?per_page=${MAX_REPOSITORY_DEPLOYMENTS}&page=1`
    case "deployment-statuses":
      return `${repositoryPath}/deployments/${operation.deploymentId}/statuses?per_page=${MAX_DEPLOYMENT_STATUSES_PER_PAGE}&page=1`
  }
}

function decodeSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment)
    return hasControlCharacter(decoded) || decoded.includes("\\")
      ? null
      : decoded
  } catch {
    return null
  }
}

function parseQuery(rawQuery: string | null): Map<string, string> | null {
  const query = new Map<string, string>()
  if (rawQuery === null || rawQuery === "") {
    return rawQuery === "" ? null : query
  }
  for (const pair of rawQuery.split("&")) {
    const separator = pair.indexOf("=")
    if (separator <= 0) return null
    const key = pair.slice(0, separator)
    const value = pair.slice(separator + 1)
    if (!/^[a-z_]+$/.test(key) || !/^[A-Za-z\d]+$/.test(value)) return null
    if (query.has(key)) return null
    query.set(key, value)
  }
  return query
}

function hasExactQuery(
  query: ReadonlyMap<string, string>,
  expected: Readonly<Record<string, string>>,
): boolean {
  const entries = Object.entries(expected)
  return (
    query.size === entries.length &&
    entries.every(([key, value]) => query.get(key) === value)
  )
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint < 0x20 || codePoint === 0x7f
  })
}
