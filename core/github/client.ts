import type {
  RepositoryBranchList,
  RepositoryIdentity,
  RepositoryMetadata,
} from "../../types/repository"
import type { PreviewRepositoryRef } from "../../types/preview"
import { isRepositoryRelativeDirectoryPath } from "./repositoryPath"
import { isRepositoryBranchName } from "./repositoryRef"

const DEFAULT_API_BASE_URL = "https://api.github.com"
const GITHUB_API_VERSION = "2026-03-10"
export const MAX_REPOSITORY_BRANCHES = 100
/** Bounded, single-page deployment list; never paginated further. */
export const MAX_REPOSITORY_DEPLOYMENTS = 10
/** Bounded, single-page status list per deployment; never paginated further. */
export const MAX_DEPLOYMENT_STATUSES_PER_PAGE = 30

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

interface GitHubBranchListEntry extends GitHubBranchResponse {
  name: string
}

interface GitHubCommitResponse {
  sha: string
}

interface GitHubDeploymentResponse {
  id: number
  sha: string
  ref: string
  environment: string
  production_environment?: boolean
  created_at: string
}

interface GitHubDeploymentStatusResponse {
  state: string
  environment_url?: string | null
  created_at: string
}

export interface GitHubDeploymentSummary {
  id: number
  sha: string
  ref: string
  environment: string
  productionEnvironment: boolean
  createdAt: string
}

export interface GitHubDeploymentStatusSummary {
  state: string
  environmentUrl: string | null
  createdAt: string
}

export interface GitHubDeploymentsPage {
  deployments: GitHubDeploymentSummary[]
  /** True when the bounded list may be missing older deployments. */
  truncated: boolean
}

export interface GitHubDeploymentStatusesPage {
  statuses: GitHubDeploymentStatusSummary[]
  /** True when the bounded list may be missing older statuses. */
  truncated: boolean
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
  /**
   * Resolves an optional server-owned GitHub API credential, or
   * null/undefined for public unauthenticated requests. The extension uses
   * the unauthenticated path; GitHub App user credentials are identity-only
   * and are never supplied to this repository-data client.
   */
  getToken?: () =>
    string | null | undefined | Promise<string | null | undefined>
}

export class GitHubClient {
  private readonly apiBaseUrl: string
  private readonly fetcher: typeof fetch
  private readonly getToken: () => Promise<string | null | undefined>

  constructor(options: GitHubClientOptions = {}) {
    this.apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL
    this.fetcher = (options.fetcher ?? globalThis.fetch).bind(globalThis)
    this.getToken = async () => options.getToken?.()
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

  async getRepositoryMetadataAtBranch(
    repository: RepositoryIdentity,
    branchName: string,
    signal?: AbortSignal,
  ): Promise<RepositoryMetadata> {
    if (!isRepositoryBranchName(branchName)) {
      throw new GitHubApiError(
        "invalid-response",
        "The selected GitHub branch name is invalid.",
      )
    }

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

    let branch: GitHubBranchResponse

    try {
      branch = await this.requestJson(
        `${repositoryPath}/branches/${encodeURIComponent(branchName)}`,
        isGitHubBranchResponse,
        signal,
      )
    } catch (error) {
      if (error instanceof GitHubApiError && error.code === "not-found") {
        throw new GitHubApiError(
          "not-found",
          `The selected branch "${branchName}" no longer exists or is unavailable.`,
          error.status,
        )
      }
      throw error
    }

    return {
      repositoryId: details.id,
      owner: details.owner.login,
      repo: details.name,
      defaultBranch: details.default_branch,
      commitSha: branch.commit.sha,
      homepage: normalizeHomepage(details.homepage),
    }
  }

  async listRepositoryBranches(
    repository: RepositoryIdentity,
    signal?: AbortSignal,
  ): Promise<RepositoryBranchList> {
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

    const page = await this.requestJson(
      `${repositoryPath}/branches?per_page=${MAX_REPOSITORY_BRANCHES}&page=1`,
      isGitHubBranchListResponse,
      signal,
    )
    const uniqueNames = Array.from(new Set(page.map((branch) => branch.name)))
    const withoutDefault = uniqueNames.filter(
      (name) => name !== details.default_branch,
    )
    const branches = [
      details.default_branch,
      ...withoutDefault.slice(0, MAX_REPOSITORY_BRANCHES - 1),
    ]

    return {
      defaultBranch: details.default_branch,
      branches,
      truncated:
        page.length >= MAX_REPOSITORY_BRANCHES ||
        withoutDefault.length > MAX_REPOSITORY_BRANCHES - 1,
    }
  }

  async getRepositoryMetadataAtCommit(
    repository: PreviewRepositoryRef,
    signal?: AbortSignal,
  ): Promise<RepositoryMetadata> {
    const repositoryPath = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`
    const details = await this.requestJson(
      repositoryPath,
      isGitHubRepositoryResponse,
      signal,
    )

    if (
      details.private ||
      details.id !== repository.repositoryId ||
      details.owner.login.toLowerCase() !== repository.owner.toLowerCase() ||
      details.name.toLowerCase() !== repository.name.toLowerCase()
    ) {
      throw new GitHubApiError(
        "not-found",
        "The requested public repository identity could not be verified.",
        404,
      )
    }

    const commit = await this.requestJson(
      `${repositoryPath}/commits/${encodeURIComponent(repository.commitSha)}`,
      isGitHubCommitResponse,
      signal,
    )

    if (commit.sha.toLowerCase() !== repository.commitSha.toLowerCase()) {
      throw new GitHubApiError(
        "invalid-response",
        "GitHub returned a different commit than requested.",
      )
    }

    return {
      repositoryId: details.id,
      owner: details.owner.login,
      repo: details.name,
      defaultBranch: details.default_branch,
      commitSha: commit.sha,
      homepage: normalizeHomepage(details.homepage),
    }
  }

  async getRepositoryRootEntries(
    repository: RepositoryMetadata,
    signal?: AbortSignal,
  ): Promise<GitHubContentEntry[]> {
    return this.getRepositoryDirectoryEntries(repository, "", signal)
  }

  /**
   * Lists one directory's immediate entries at the repository's resolved
   * commit. `path` must be a validated, repository-relative path (the empty
   * string means the repository root); this is a fixed, bounded GitHub
   * operation, not an arbitrary-path fetch primitive.
   */
  async getRepositoryDirectoryEntries(
    repository: RepositoryMetadata,
    path: string,
    signal?: AbortSignal,
  ): Promise<GitHubContentEntry[]> {
    if (!isRepositoryRelativeDirectoryPath(path)) {
      throw new GitHubApiError(
        "invalid-response",
        "The requested repository directory path is invalid.",
      )
    }

    const repositoryPath = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`
    const suffix =
      path === ""
        ? ""
        : `/${path
            .split("/")
            .map((segment) => encodeURIComponent(segment))
            .join("/")}`

    return this.requestJson(
      `${repositoryPath}/contents${suffix}?ref=${encodeURIComponent(repository.commitSha)}`,
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

  /**
   * Lists this repository's most recent deployments, newest bound applied
   * (`MAX_REPOSITORY_DEPLOYMENTS`, single page, never paginated further).
   * `production_environment`/`environment`/`ref`/`sha` come straight from
   * GitHub; none of this proves a deployment is actually live -- callers
   * still need a successful status with a valid `environment_url` from
   * `listDeploymentStatuses`.
   */
  async listRepositoryDeployments(
    repository: RepositoryIdentity,
    signal?: AbortSignal,
  ): Promise<GitHubDeploymentsPage> {
    const repositoryPath = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`
    const page = await this.requestJson(
      `${repositoryPath}/deployments?per_page=${MAX_REPOSITORY_DEPLOYMENTS}&page=1`,
      isGitHubDeploymentListResponse,
      signal,
    )

    return {
      deployments: page.map((entry) => ({
        id: entry.id,
        sha: entry.sha,
        ref: entry.ref,
        environment: entry.environment,
        productionEnvironment: entry.production_environment === true,
        createdAt: entry.created_at,
      })),
      truncated: page.length >= MAX_REPOSITORY_DEPLOYMENTS,
    }
  }

  /**
   * Lists one deployment's statuses, bounded to a single page
   * (`MAX_DEPLOYMENT_STATUSES_PER_PAGE`, never paginated further). Statuses
   * are not guaranteed to arrive in any particular order, so callers must
   * pick the most recent by `createdAt` rather than assuming position.
   */
  async listDeploymentStatuses(
    repository: RepositoryIdentity,
    deploymentId: number,
    signal?: AbortSignal,
  ): Promise<GitHubDeploymentStatusesPage> {
    if (!Number.isInteger(deploymentId) || deploymentId <= 0) {
      throw new GitHubApiError(
        "invalid-response",
        "The requested deployment id is invalid.",
      )
    }

    const repositoryPath = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`
    const page = await this.requestJson(
      `${repositoryPath}/deployments/${deploymentId}/statuses?per_page=${MAX_DEPLOYMENT_STATUSES_PER_PAGE}&page=1`,
      isGitHubDeploymentStatusListResponse,
      signal,
    )

    return {
      statuses: page.map((entry) => ({
        state: entry.state,
        environmentUrl: entry.environment_url ?? null,
        createdAt: entry.created_at,
      })),
      truncated: page.length >= MAX_DEPLOYMENT_STATUSES_PER_PAGE,
    }
  }

  private async buildHeaders(): Promise<Record<string, string>> {
    const token = await this.getToken()

    return {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }
  }

  private async requestJson<T>(
    path: string,
    validate: (value: unknown) => value is T,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response

    try {
      response = await this.fetcher(`${this.apiBaseUrl}${path}`, {
        headers: await this.buildHeaders(),
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
        headers: await this.buildHeaders(),
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
    isRepositoryBranchName(value.default_branch) &&
    (typeof value.homepage === "string" || value.homepage === null) &&
    typeof value.private === "boolean"
  )
}

function isGitHubBranchListResponse(
  value: unknown,
): value is GitHubBranchListEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (branch) =>
        isObject(branch) &&
        isRepositoryBranchName(branch.name) &&
        isGitHubBranchResponse(branch),
    )
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

function isGitHubCommitResponse(value: unknown): value is GitHubCommitResponse {
  return (
    isObject(value) &&
    typeof value.sha === "string" &&
    /^[a-f\d]{40}$/i.test(value.sha)
  )
}

function isGitHubDeploymentListResponse(
  value: unknown,
): value is GitHubDeploymentResponse[] {
  return Array.isArray(value) && value.every(isGitHubDeploymentResponse)
}

function isGitHubDeploymentResponse(
  value: unknown,
): value is GitHubDeploymentResponse {
  return (
    isObject(value) &&
    Number.isInteger(value.id) &&
    typeof value.sha === "string" &&
    /^[a-f\d]{40}$/i.test(value.sha) &&
    typeof value.ref === "string" &&
    value.ref.length > 0 &&
    value.ref.length <= 512 &&
    typeof value.environment === "string" &&
    value.environment.length > 0 &&
    value.environment.length <= 255 &&
    (value.production_environment === undefined ||
      typeof value.production_environment === "boolean") &&
    typeof value.created_at === "string" &&
    !Number.isNaN(Date.parse(value.created_at))
  )
}

function isGitHubDeploymentStatusListResponse(
  value: unknown,
): value is GitHubDeploymentStatusResponse[] {
  return Array.isArray(value) && value.every(isGitHubDeploymentStatusResponse)
}

function isGitHubDeploymentStatusResponse(
  value: unknown,
): value is GitHubDeploymentStatusResponse {
  return (
    isObject(value) &&
    typeof value.state === "string" &&
    value.state.length > 0 &&
    value.state.length <= 64 &&
    (value.environment_url === undefined ||
      value.environment_url === null ||
      typeof value.environment_url === "string") &&
    typeof value.created_at === "string" &&
    !Number.isNaN(Date.parse(value.created_at))
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
