import type { IncomingMessage } from "node:http"

import type { PreviewRequester } from "../../types/preview"
import { extractBearerToken } from "./bearerToken"
import { HttpIngressError } from "./nodeHttpServer"

const DEFAULT_API_BASE_URL = "https://api.github.com"
const DEFAULT_CACHE_TTL_MS = 5 * 60_000
const MAX_CACHE_ENTRIES = 10_000

export interface GitHubRequesterAuthOptions {
  apiBaseUrl?: string
  fetcher?: typeof fetch
  cacheTtlMs?: number
  now?: () => Date
}

interface CachedIdentity {
  subject: string
  expiresAt: number
}

/**
 * Verifies the caller's own GitHub personal access token -- the same one
 * the extension already asks users for to raise its GitHub REST API rate
 * limit (core/github/tokenStorage.ts, entrypoints/options/App.tsx), reused
 * here instead of standing up a separate OAuth App/login flow. `resolve()`
 * verifies it against GitHub's own `/user` endpoint and derives
 * `requester.subject` from the numeric GitHub user id, which is stable
 * even if the user later renames their account.
 *
 * Used only at login (`POST /v1/auth/session`, see
 * services/local-preview/devServer.ts): the extension exchanges this
 * credential for a short-lived Peephole session once, then uses that
 * session (verified by PreviewSessionAuth, not this class) for every
 * other preview API call. This is why the raw GitHub token itself is
 * never sent more than once per session lifetime, and why a compromised
 * Preview API only ever exposes Peephole-scoped session tokens, not the
 * caller's actual GitHub credential -- see PreviewSessionIssuer's doc
 * comment.
 *
 * The verified-identity cache still exists because a user might sign in
 * more than once in quick succession (e.g. two tabs opening side panels
 * around the same time); it is not there to cover per-request polling
 * anymore, since polling now uses the cheaper, local session check.
 */
export class GitHubRequesterAuth {
  private readonly apiBaseUrl: string
  private readonly fetcher: typeof fetch
  private readonly cacheTtlMs: number
  private readonly now: () => Date
  private readonly cache = new Map<string, CachedIdentity>()

  constructor(options: GitHubRequesterAuthOptions = {}) {
    this.apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL
    this.fetcher = options.fetcher ?? fetch
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.now = options.now ?? (() => new Date())
  }

  async resolve(request: IncomingMessage): Promise<PreviewRequester> {
    const ip = request.socket.remoteAddress ?? "127.0.0.1"
    const token = extractBearerToken(request.headers.authorization)

    if (!token) {
      throw new HttpIngressError(
        401,
        "A GitHub personal access token is required. Set one in the extension's options page.",
        "UNAUTHORIZED",
      )
    }

    const cached = this.cache.get(token)
    const nowMs = this.now().getTime()

    if (cached) {
      if (cached.expiresAt > nowMs) {
        return { subject: cached.subject, ip }
      }
      this.cache.delete(token)
    }

    const subject = await this.verify(token)

    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      this.cache.clear()
    }
    this.cache.set(token, { subject, expiresAt: nowMs + this.cacheTtlMs })

    return { subject, ip }
  }

  private async verify(token: string): Promise<string> {
    let response: Response

    try {
      response = await this.fetcher(`${this.apiBaseUrl}/user`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      })
    } catch {
      throw new HttpIngressError(
        503,
        "GitHub could not be reached to verify your token. Try again shortly.",
        "INTERNAL_ERROR",
      )
    }

    if (response.status === 401 || response.status === 403) {
      throw new HttpIngressError(
        401,
        "This GitHub token is invalid, expired, or has been revoked.",
        "UNAUTHORIZED",
      )
    }

    if (!response.ok) {
      throw new HttpIngressError(
        503,
        "GitHub could not verify your token right now. Try again shortly.",
        "INTERNAL_ERROR",
      )
    }

    let body: unknown

    try {
      body = await response.json()
    } catch {
      throw new HttpIngressError(
        503,
        "GitHub returned an unreadable response while verifying your token.",
        "INTERNAL_ERROR",
      )
    }

    if (!isObject(body) || !Number.isInteger(body.id)) {
      throw new HttpIngressError(
        503,
        "GitHub returned an unexpected response while verifying your token.",
        "INTERNAL_ERROR",
      )
    }

    // Prefixed so a GitHub user id can never collide with a requester
    // subject minted some other way (e.g. local-dev-user).
    return `github:${String(body.id)}`
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
