import {
  isGitHubBranchListResponse,
  isGitHubBranchResponse,
  isGitHubContentEntriesResponse,
  isGitHubDeploymentListResponse,
  isGitHubDeploymentStatusListResponse,
  isGitHubFileContentResponse,
  isGitHubRepositoryResponse,
} from "../../core/github/client"
import { GitHubRequestCache } from "../../core/github/requestCache"
import type { PreviewRequester } from "../../types/preview"
import type { PreviewHttpRequest, PreviewHttpResponse } from "./http"
import {
  parseGitHubGatewayPath,
  toGitHubUpstreamPath,
  type GitHubGatewayOperation,
} from "./githubGatewayRoutes"

export const GITHUB_GATEWAY_PATH = "/v1/github/rest"
/** Present on every gateway-produced response so the extension can tell a
 * GitHub result apart from preview-API infrastructure errors. `disabled`
 * means the operator or the credential guard turned the gateway off. */
export const GITHUB_GATEWAY_HEADER = "x-peephole-github-gateway"

const GITHUB_API_ORIGIN = "https://api.github.com"
const GITHUB_API_VERSION = "2026-03-10"
const UPSTREAM_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 12_000
const MAX_UPSTREAM_RESPONSE_BYTES = 4 * 1024 * 1024
const VISIBILITY_TTL_MS = 30_000
const MUTABLE_TTL_MS = 30_000
const MISSING_TTL_MS = 15_000
const CREDENTIAL_GUARD_TTL_MS = 10 * 60_000
const CREDENTIAL_GUARD_FAILURE_TTL_MS = 60_000
const DEFAULT_SECONDARY_BACKOFF_MS = 60_000
/** Classic-PAT scopes that cannot read private repository data. */
const PUBLIC_ONLY_SCOPES = new Set(["public_repo", "read:user", "user:email"])

export interface GitHubGatewayLimits {
  /** Gateway requests per subject per window. */
  perSubject: number
  /** Gateway requests per client IP per window. */
  perIp: number
  windowMs: number
  /** Concurrent upstream GitHub requests across all callers. */
  maxConcurrentUpstream: number
  /** Primary-quota calls held back for preview admission. */
  quotaReserve: number
}

export const DEFAULT_GITHUB_GATEWAY_LIMITS: GitHubGatewayLimits = {
  perSubject: 120,
  perIp: 240,
  windowMs: 60_000,
  maxConcurrentUpstream: 8,
  quotaReserve: 500,
}

export interface GitHubGatewayOptions {
  /** Server-owned credential. Required; it never leaves this module. */
  token: string
  fetcher?: typeof fetch
  now?: () => number
  limits?: Partial<GitHubGatewayLimits>
  log?: (message: string) => void
}

type UpstreamResult = { status: 200; body: unknown } | { status: 404 }

interface PublicRepository {
  id: number
  body: Record<string, unknown>
}

class GatewayFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAt: Date | null = null,
    readonly disabled = false,
  ) {
    super(message)
  }
}

/**
 * Authenticated, public-only read gateway for the extension's fixed GitHub
 * REST operations. A request reaches this handler only after
 * `PreviewSessionAuth` verified the Peephole session (see NodePreviewApiServer).
 */
export class GitHubGateway {
  private readonly token: string
  private readonly fetcher: typeof fetch
  private readonly now: () => number
  private readonly limits: GitHubGatewayLimits
  private readonly log: (message: string) => void
  private readonly cache: GitHubRequestCache
  private readonly subjectWindows = new FixedWindowLimiter()
  private readonly ipWindows = new FixedWindowLimiter()
  private readonly upstreamSlots: Semaphore
  private guard: { ok: boolean; expiresAt: number } | null = null
  private guardCheck: Promise<boolean> | null = null
  private quota: { remaining: number; resetAt: number } | null = null
  private cooldownUntil = 0
  /** Upstream GitHub calls actually sent (for measurement and tests). */
  upstreamRequestCount = 0

  constructor(options: GitHubGatewayOptions) {
    if (!options.token) throw new Error("GitHub gateway requires a token.")
    this.token = options.token
    this.fetcher = (options.fetcher ?? globalThis.fetch).bind(globalThis)
    this.now = options.now ?? Date.now
    this.limits = { ...DEFAULT_GITHUB_GATEWAY_LIMITS, ...options.limits }
    this.log = options.log ?? ((message) => console.error(message))
    this.upstreamSlots = new Semaphore(this.limits.maxConcurrentUpstream)
    this.cache = new GitHubRequestCache({
      maxEntries: 4_096,
      maxBytes: 64 * 1024 * 1024,
      now: this.now,
    })
  }

  async handle(request: PreviewHttpRequest): Promise<PreviewHttpResponse> {
    try {
      if (request.method !== "POST") {
        throw new GatewayFailure(405, "Method not allowed.")
      }
      const operation = parseBody(request.body)
      if (!operation) {
        throw new GatewayFailure(400, "Unsupported GitHub operation.")
      }
      this.enforceCallerLimits(request.requester)
      if (!(await this.credentialIsPublicOnly())) {
        throw new GatewayFailure(
          503,
          "The GitHub gateway is unavailable.",
          null,
          true,
        )
      }
      const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      return jsonResponse(200, await this.run(operation, signal))
    } catch (error) {
      return failureResponse(error, this.now)
    }
  }

  private async run(
    operation: GitHubGatewayOperation,
    signal: AbortSignal,
  ): Promise<unknown> {
    // Every operation re-proves public visibility (bounded staleness), so a
    // repository that turns private stops being served -- including content
    // already in the immutable cache -- within VISIBILITY_TTL_MS.
    const repository = await this.loadPublicRepository(operation, signal)
    if (operation.kind === "repository") return repository.body

    const key = `${operation.kind}:${repository.id}:${toGitHubUpstreamPath({
      ...operation,
      owner: "-",
      repo: "-",
    })}`
    const result = await this.cache.load(
      key,
      (shared) => this.fetchOperation(operation, shared),
      {
        signal,
        ttlMs: (value) => cacheTtl(operation, value as UpstreamResult),
        sizeOf: estimateBytes,
      },
    )
    if (result.status === 404) {
      throw new GatewayFailure(404, "Not Found")
    }
    return result.body
  }

  private async loadPublicRepository(
    operation: GitHubGatewayOperation,
    signal: AbortSignal,
  ): Promise<PublicRepository> {
    const key = `repository:${operation.owner.toLowerCase()}/${operation.repo.toLowerCase()}`
    const result = await this.cache.load(
      key,
      async (shared): Promise<UpstreamResult> => {
        const upstream = await this.fetchUpstream(
          toGitHubUpstreamPath({ ...operation, kind: "repository" }),
          shared,
        )
        if (upstream.status === 404) return upstream
        const value = upstream.body
        if (!isGitHubRepositoryResponse(value)) throw invalidResponse()
        // Anything not provably public (private, internal, or a missing
        // visibility field) is indistinguishable from absent to the caller.
        const visibility = (value as unknown as Record<string, unknown>)
          .visibility
        if (value.private !== false || visibility !== "public") {
          return { status: 404 }
        }
        return {
          status: 200,
          body: {
            id: value.id,
            name: value.name,
            owner: { login: value.owner.login },
            default_branch: value.default_branch,
            homepage: value.homepage,
            private: false,
            visibility: "public",
          },
        }
      },
      {
        signal,
        ttlMs: (value) =>
          (value as UpstreamResult).status === 404
            ? MISSING_TTL_MS
            : VISIBILITY_TTL_MS,
        sizeOf: estimateBytes,
      },
    )
    if (result.status === 404) throw new GatewayFailure(404, "Not Found")
    const body = result.body as Record<string, unknown>
    return { id: body.id as number, body }
  }

  private async fetchOperation(
    operation: Exclude<GitHubGatewayOperation, { kind: "repository" }>,
    signal: AbortSignal,
  ): Promise<UpstreamResult> {
    const upstream = await this.fetchUpstream(
      toGitHubUpstreamPath(operation),
      signal,
    )
    if (upstream.status === 404) return upstream
    return { status: 200, body: filterOperationBody(operation, upstream.body) }
  }

  private async fetchUpstream(
    path: string,
    signal: AbortSignal,
  ): Promise<UpstreamResult> {
    this.throwIfQuotaProtected()
    const release = await this.upstreamSlots.acquire(signal)
    let response: Response
    try {
      this.throwIfQuotaProtected()
      this.upstreamRequestCount += 1
      response = await this.fetcher(`${GITHUB_API_ORIGIN}${path}`, {
        method: "GET",
        headers: this.headers(),
        redirect: "manual",
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        ]),
      })
    } catch (error) {
      release()
      if (signal.aborted || error instanceof GatewayFailure) throw error
      throw new GatewayFailure(502, "GitHub could not be reached.")
    }

    try {
      this.recordQuota(response.headers)
      if (response.status === 404) return { status: 404 }
      if (response.status === 401) {
        // The server credential itself is rejected: stop using it.
        this.guard = {
          ok: false,
          expiresAt: this.now() + CREDENTIAL_GUARD_FAILURE_TTL_MS,
        }
        this.log("[peephole] GitHub gateway credential was rejected (401).")
        throw new GatewayFailure(
          503,
          "The GitHub gateway is unavailable.",
          null,
          true,
        )
      }
      if (isRateLimitedResponse(response)) {
        const retryAt =
          getRetryAt(response.headers, this.now) ??
          new Date(this.now() + DEFAULT_SECONDARY_BACKOFF_MS)
        this.cooldownUntil = Math.max(this.cooldownUntil, retryAt.getTime())
        throw new GatewayFailure(429, "GitHub API rate limit reached.", retryAt)
      }
      if (!response.ok) {
        // Includes every 3xx: redirects are never followed.
        throw new GatewayFailure(
          502,
          `GitHub request failed with status ${response.status}.`,
        )
      }
      return { status: 200, body: await readBoundedJson(response) }
    } finally {
      release()
    }
  }

  private headers(): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      Authorization: `Bearer ${this.token}`,
    }
  }

  private enforceCallerLimits(requester: PreviewRequester): void {
    const now = this.now()
    const { windowMs } = this.limits
    const retryAt =
      this.subjectWindows.hit(
        `subject:${requester.subject}`,
        this.limits.perSubject,
        windowMs,
        now,
      ) ??
      (requester.ip
        ? this.ipWindows.hit(
            `ip:${requester.ip}`,
            this.limits.perIp,
            windowMs,
            now,
          )
        : null)
    if (retryAt !== null) {
      throw new GatewayFailure(
        429,
        "Peephole GitHub request limit reached.",
        new Date(retryAt),
      )
    }
  }

  private throwIfQuotaProtected(): void {
    const now = this.now()
    if (this.cooldownUntil > now) {
      throw new GatewayFailure(
        429,
        "GitHub API rate limit reached.",
        new Date(this.cooldownUntil),
      )
    }
    if (
      this.quota &&
      this.quota.resetAt > now &&
      this.quota.remaining <= this.limits.quotaReserve
    ) {
      // The remaining primary quota is held for preview admission.
      throw new GatewayFailure(
        429,
        "GitHub API rate limit reached.",
        new Date(this.quota.resetAt),
      )
    }
  }

  private recordQuota(headers: Headers): void {
    const remaining = Number(headers.get("x-ratelimit-remaining"))
    const reset = Number(headers.get("x-ratelimit-reset"))
    if (
      headers.has("x-ratelimit-remaining") &&
      Number.isInteger(remaining) &&
      remaining >= 0 &&
      Number.isFinite(reset) &&
      reset > 0
    ) {
      this.quota = { remaining, resetAt: reset * 1000 }
    }
  }

  /**
   * Fails closed unless the configured credential provably cannot read
   * private repository data: no private-capable classic scope, and the
   * token lists zero private repositories. Re-checked periodically.
   */
  private async credentialIsPublicOnly(): Promise<boolean> {
    if (this.guard && this.guard.expiresAt > this.now()) return this.guard.ok
    this.guardCheck ??= this.checkCredential().finally(() => {
      this.guardCheck = null
    })
    return this.guardCheck
  }

  private async checkCredential(): Promise<boolean> {
    let ok = false
    try {
      this.upstreamRequestCount += 1
      const response = await this.fetcher(
        `${GITHUB_API_ORIGIN}/user/repos?visibility=private&per_page=1&page=1`,
        {
          method: "GET",
          headers: this.headers(),
          redirect: "manual",
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        },
      )
      this.recordQuota(response.headers)
      const scopes = response.headers.get("x-oauth-scopes")
      const scopesArePublicOnly =
        scopes === null ||
        scopes
          .split(",")
          .map((scope) => scope.trim())
          .filter(Boolean)
          .every((scope) => PUBLIC_ONLY_SCOPES.has(scope))
      const body = response.ok ? await readBoundedJson(response) : null
      ok =
        response.status === 200 &&
        scopesArePublicOnly &&
        Array.isArray(body) &&
        body.length === 0
      if (!ok) {
        this.log(
          `[peephole] GitHub gateway disabled: credential is not proven public-only (status ${response.status}).`,
        )
      }
    } catch {
      this.log(
        "[peephole] GitHub gateway disabled: credential check could not complete.",
      )
    }
    this.guard = {
      ok,
      expiresAt:
        this.now() +
        (ok ? CREDENTIAL_GUARD_TTL_MS : CREDENTIAL_GUARD_FAILURE_TTL_MS),
    }
    return ok
  }
}

/** Response used when the operator has not enabled the gateway. */
export function disabledGitHubGatewayResponse(): PreviewHttpResponse {
  return failureResponse(
    new GatewayFailure(503, "The GitHub gateway is unavailable.", null, true),
    Date.now,
  )
}

function parseBody(body: unknown): GitHubGatewayOperation | null {
  if (
    !isObject(body) ||
    Object.keys(body).length !== 1 ||
    typeof body.path !== "string"
  ) {
    return null
  }
  return parseGitHubGatewayPath(body.path)
}

function cacheTtl(
  operation: GitHubGatewayOperation,
  value: UpstreamResult,
): number | null {
  if (value.status === 404) return MISSING_TTL_MS
  switch (operation.kind) {
    case "contents":
      // Keyed by verified repository id + exact commit SHA + path.
      return null
    case "branch":
    case "branches":
      return MUTABLE_TTL_MS
    default:
      // Deployment evidence stays fresh; concurrent callers still share one
      // in-flight request.
      return 0
  }
}

/** Returns only the fields the extension client reads. */
function filterOperationBody(
  operation: Exclude<GitHubGatewayOperation, { kind: "repository" }>,
  value: unknown,
): unknown {
  switch (operation.kind) {
    case "branch":
      if (!isGitHubBranchResponse(value)) throw invalidResponse()
      return { commit: { sha: value.commit.sha } }
    case "branches":
      if (!isGitHubBranchListResponse(value)) throw invalidResponse()
      return value.map((branch) => ({
        name: branch.name,
        commit: { sha: branch.commit.sha },
      }))
    case "contents":
      if (Array.isArray(value)) {
        if (!isGitHubContentEntriesResponse(value)) throw invalidResponse()
        return value.map(({ type, name, path, size }) => ({
          type,
          name,
          path,
          size,
        }))
      }
      if (isGitHubFileContentResponse(value)) {
        return {
          type: value.type,
          path: value.path,
          size: value.size,
          encoding: value.encoding,
          content: value.content,
        }
      }
      // A symlink/submodule/oversized object: forward only its type so the
      // client reports its usual "unexpected format" error.
      if (isObject(value) && typeof value.type === "string") {
        return { type: value.type.slice(0, 32) }
      }
      throw invalidResponse()
    case "deployments":
      if (!isGitHubDeploymentListResponse(value)) throw invalidResponse()
      return value.map((deployment) => ({
        id: deployment.id,
        sha: deployment.sha,
        ref: deployment.ref,
        environment: deployment.environment,
        ...(deployment.production_environment === undefined
          ? {}
          : { production_environment: deployment.production_environment }),
        created_at: deployment.created_at,
      }))
    case "deployment-statuses":
      if (!isGitHubDeploymentStatusListResponse(value)) throw invalidResponse()
      return value.map((status) => ({
        state: status.state,
        environment_url: status.environment_url ?? null,
        created_at: status.created_at,
      }))
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_UPSTREAM_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new GatewayFailure(502, "GitHub response is too large.")
  }
  const reader = response.body?.getReader()
  if (!reader) throw invalidResponse()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_UPSTREAM_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new GatewayFailure(502, "GitHub response is too large.")
    }
    chunks.push(value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
  } catch {
    throw invalidResponse()
  }
}

function isRateLimitedResponse(response: Response): boolean {
  return (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.has("retry-after")))
  )
}

function getRetryAt(headers: Headers, now: () => number): Date | null {
  const retryAfter = Number(headers.get("retry-after"))
  if (headers.has("retry-after") && Number.isFinite(retryAfter)) {
    return new Date(now() + Math.max(0, retryAfter) * 1000)
  }
  const reset = Number(headers.get("x-ratelimit-reset"))
  if (headers.has("x-ratelimit-reset") && Number.isFinite(reset) && reset > 0) {
    return new Date(reset * 1000)
  }
  return null
}

function invalidResponse(): GatewayFailure {
  return new GatewayFailure(502, "GitHub returned an unexpected response.")
}

function jsonResponse(status: number, body: unknown): PreviewHttpResponse {
  return { status, headers: { [GITHUB_GATEWAY_HEADER]: "1" }, body }
}

/** GitHub-shaped error bodies and headers, so the extension's existing
 * `GitHubClient` error mapping (404 / rate-limited / unavailable) applies
 * unchanged. Server details never reach the body. */
function failureResponse(
  error: unknown,
  now: () => number,
): PreviewHttpResponse {
  if (!(error instanceof GatewayFailure)) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      return jsonResponse(504, { message: "GitHub request timed out." })
    }
    return jsonResponse(502, { message: "GitHub request failed." })
  }
  const headers: Record<string, string> = {
    [GITHUB_GATEWAY_HEADER]: error.disabled ? "disabled" : "1",
  }
  if (error.status === 429 && error.retryAt) {
    const seconds = Math.max(
      1,
      Math.ceil((error.retryAt.getTime() - now()) / 1000),
    )
    headers["retry-after"] = String(seconds)
    headers["x-ratelimit-remaining"] = "0"
    headers["x-ratelimit-reset"] = String(
      Math.ceil(error.retryAt.getTime() / 1000),
    )
  }
  return { status: error.status, headers, body: { message: error.message } }
}

function estimateBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value))
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

class FixedWindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>()

  /** Returns the retry time when `key` is over `limit`, otherwise null. */
  hit(
    key: string,
    limit: number,
    windowMs: number,
    now: number,
  ): number | null {
    if (this.windows.size > 10_000) {
      for (const [entryKey, entry] of this.windows) {
        if (entry.start + windowMs <= now) this.windows.delete(entryKey)
      }
    }
    const current = this.windows.get(key)
    if (!current || current.start + windowMs <= now) {
      this.windows.set(key, { start: now, count: 1 })
      return null
    }
    if (current.count >= limit) return current.start + windowMs
    current.count += 1
    return null
  }
}

class Semaphore {
  private available: number
  private readonly waiters: Array<() => void> = []

  constructor(size: number) {
    this.available = size
  }

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw signal.reason
    if (this.available > 0) {
      this.available -= 1
      return this.releaser()
    }
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener("abort", onAbort)
        resolve()
      }
      const onAbort = () => {
        const index = this.waiters.indexOf(grant)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(signal.reason)
      }
      this.waiters.push(grant)
      signal.addEventListener("abort", onAbort, { once: true })
    })
    return this.releaser()
  }

  private releaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next) next()
      else this.available += 1
    }
  }
}
