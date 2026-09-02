import type {
  RepositoryIdentity,
  RepositoryMetadata,
} from "../../types/repository"

const DEFAULT_API_BASE_URL = "https://api.github.com"
const GITHUB_API_VERSION = "2026-03-10"

export type GitHubApiErrorCode =
  "not-found" | "rate-limited" | "network" | "invalid-response" | "unavailable"

export class GitHubApiError extends Error {
  constructor(
    readonly code: GitHubApiErrorCode,
    message: string,
    readonly status: number | null = null,
    readonly retryAt: Date | null = null,
  ) {
    super(message)
    this.name = "GitHubApiError"
  }
}

interface GitHubRepositoryResponse {
  id: number
  name: string
  owner: {
    login: string
  }
  default_branch: string
  homepage: string | null
  private: boolean
}

interface GitHubBranchResponse {
  commit: {
    sha: string
  }
}

export interface GitHubContentEntry {
  type: "file" | "dir" | "symlink" | "submodule"
  name: string
  path: string
  size: number
}

interface GitHubFileContentResponse {
  type: "file"
  path: string
  size: number
  encoding: "base64"
  content: string
}

export interface GitHubClientOptions {
  apiBaseUrl?: string
  fetcher?: typeof fetch
}

export class GitHubClient {
  private readonly apiBaseUrl: string
  private readonly fetcher: typeof fetch

  constructor(options: GitHubClientOptions = {}) {
    this.apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL
    this.fetcher = (options.fetcher ?? globalThis.fetch).bind(globalThis)
  }

  async getRepositoryMetadata(
    repository: RepositoryIdentity,
    signal?: AbortSignal,
  ): Promise<RepositoryMetadata> {
    const repositoryPath = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`
    const details = await this.requestJson(
      repositoryPath,
      isGitHubRepositoryResponse,
      signal,
    )

    if (details.private) {
      throw new GitHubApiError(
        "not-found",
        "Peephole v0.1 supports public repositories only.",
        404,
      )
    }

    const branch = await this.requestJson(
      `${repositoryPath}/branches/${encodeURIComponent(details.default_branch)}`,
      isGitHubBranchResponse,
      signal,
    )

    return {
      repositoryId: details.id,
      owner: details.owner.login,
      repo: details.name,
      defaultBranch: details.default_branch,
      commitSha: branch.commit.sha,
      homepage: normalizeHomepage(details.homepage),
    }
  }

  async getRepositoryRootEntries(
    repository: RepositoryMetadata,
    signal?: AbortSignal,
  ): Promise<GitHubContentEntry[]> {
    const repositoryPath = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`

    return this.requestJson(
      `${repositoryPath}/contents?ref=${encodeURIComponent(repository.commitSha)}`,
      isGitHubContentEntriesResponse,
      signal,
    )
  }

  async getRepositoryTextFile(
    repository: RepositoryMetadata,
    path: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const repositoryPath = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`
    const response = await this.requestOptionalJson(
      `${repositoryPath}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(repository.commitSha)}`,
      isGitHubFileContentResponse,
      signal,
    )

    if (!response) {
      return null
    }

    if (response.size > maxBytes) {
      throw new GitHubApiError(
        "invalid-response",
        `${path} exceeds Peephole's ${maxBytes}-byte analysis limit.`,
      )
    }

    return decodeBase64Utf8(response.content, path, maxBytes)
  }

  private async requestJson<T>(
    path: string,
    validate: (value: unknown) => value is T,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response

    try {
      response = await this.fetcher(`${this.apiBaseUrl}${path}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
        signal,
      })
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }

      throw new GitHubApiError(
        "network",
        "GitHub could not be reached. Check your connection and try again.",
      )
    }

    if (!response.ok) {
      throw createResponseError(response)
    }

    let payload: unknown

    try {
      payload = await response.json()
    } catch {
      throw new GitHubApiError(
        "invalid-response",
        "GitHub returned an unreadable response.",
        response.status,
      )
    }

    if (!validate(payload)) {
      throw new GitHubApiError(
        "invalid-response",
        "GitHub returned repository data in an unexpected format.",
        response.status,
      )
    }

    return payload
  }

  private async requestOptionalJson<T>(
    path: string,
    validate: (value: unknown) => value is T,
    signal?: AbortSignal,
  ): Promise<T | null> {
    let response: Response

    try {
      response = await this.fetcher(`${this.apiBaseUrl}${path}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
        signal,
      })
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }

      throw new GitHubApiError(
        "network",
        "GitHub could not be reached. Check your connection and try again.",
      )
    }

    if (response.status === 404) {
      return null
    }

    if (!response.ok) {
      throw createResponseError(response)
    }

    let payload: unknown

    try {
      payload = await response.json()
    } catch {
      throw new GitHubApiError(
        "invalid-response",
        "GitHub returned an unreadable file response.",
        response.status,
      )
    }

    if (!validate(payload)) {
      throw new GitHubApiError(
        "invalid-response",
        "GitHub returned file data in an unexpected format.",
        response.status,
      )
    }

    return payload
  }
}

function createResponseError(response: Response): GitHubApiError {
  if (response.status === 404) {
    return new GitHubApiError(
      "not-found",
      "This repository is unavailable or is not public.",
      response.status,
    )
  }

  const isRateLimited =
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.has("retry-after")))

  if (isRateLimited) {
    return new GitHubApiError(
      "rate-limited",
      "GitHub API rate limit reached. Try again after it resets.",
      response.status,
      getRetryAt(response.headers),
    )
  }

  return new GitHubApiError(
    "unavailable",
    `GitHub request failed with status ${response.status}.`,
    response.status,
  )
}

function getRetryAt(headers: Headers): Date | null {
  const retryAfter = headers.get("retry-after")

  if (retryAfter) {
    const seconds = Number(retryAfter)

    if (Number.isFinite(seconds) && seconds >= 0) {
      return new Date(Date.now() + seconds * 1000)
    }
  }

  const reset = headers.get("x-ratelimit-reset")

  if (reset) {
    const epochSeconds = Number(reset)

    if (Number.isFinite(epochSeconds) && epochSeconds >= 0) {
      return new Date(epochSeconds * 1000)
    }
  }

  return null
}

function normalizeHomepage(value: string | null): string | null {
  if (!value) {
    return null
  }

  try {
    const url = new URL(value)

    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null
  } catch {
    return null
  }
}

function isGitHubRepositoryResponse(
  value: unknown,
): value is GitHubRepositoryResponse {
  if (!isObject(value) || !isObject(value.owner)) {
    return false
  }

  return (
    Number.isInteger(value.id) &&
    typeof value.name === "string" &&
    typeof value.owner.login === "string" &&
    typeof value.default_branch === "string" &&
    value.default_branch.length > 0 &&
    (typeof value.homepage === "string" || value.homepage === null) &&
    typeof value.private === "boolean"
  )
}

function isGitHubBranchResponse(value: unknown): value is GitHubBranchResponse {
  return (
    isObject(value) &&
    isObject(value.commit) &&
    typeof value.commit.sha === "string" &&
    /^[a-f\d]{40}$/i.test(value.commit.sha)
  )
}

function isGitHubContentEntriesResponse(
  value: unknown,
): value is GitHubContentEntry[] {
  return Array.isArray(value) && value.every(isGitHubContentEntry)
}

function isGitHubContentEntry(value: unknown): value is GitHubContentEntry {
  return (
    isObject(value) &&
    ["file", "dir", "symlink", "submodule"].includes(String(value.type)) &&
    typeof value.name === "string" &&
    typeof value.path === "string" &&
    typeof value.size === "number" &&
    value.size >= 0
  )
}

function isGitHubFileContentResponse(
  value: unknown,
): value is GitHubFileContentResponse {
  return (
    isObject(value) &&
    value.type === "file" &&
    typeof value.path === "string" &&
    typeof value.size === "number" &&
    value.size >= 0 &&
    value.encoding === "base64" &&
    typeof value.content === "string"
  )
}

function decodeBase64Utf8(
  content: string,
  path: string,
  maxBytes: number,
): string {
  try {
    const binary = atob(content.replace(/\s/g, ""))

    if (binary.length > maxBytes) {
      throw new Error("decoded content is too large")
    }

    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    )

    return new TextDecoder().decode(bytes)
  } catch {
    throw new GitHubApiError(
      "invalid-response",
      `${path} could not be decoded as repository text.`,
    )
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}
