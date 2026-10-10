import type { StoredPreviewSession } from "../preview/sessionStorage"
import { getRateLimitCooldown, type RateLimitScope } from "./client"

const GITHUB_API_ORIGIN = "https://api.github.com"
const GATEWAY_PATH = "/v1/github/rest"
const GATEWAY_HEADER = "x-peephole-github-gateway"

export interface GitHubGatewayFetcherOptions {
  /** Preview API origin (already covered by the extension host permission). */
  previewApiBaseUrl: string
  getSession: () => Promise<StoredPreviewSession | null>
  clearSession: () => Promise<void>
  directFetch?: typeof fetch
  now?: () => number
}

/**
 * A `fetch` for the extension's `GitHubClient`. With a live Peephole session
 * it sends the exact GitHub REST path to the session-authenticated, public-
 * only Preview API gateway, which performs the request with a server-owned
 * credential; the extension never sees that credential. Every other part of
 * `GitHubClient` -- validation, caching, deduplication, cooldown -- is
 * unchanged, because the gateway answers in GitHub's own response shape.
 *
 * It falls back to the direct, unauthenticated GitHub request only when the
 * caller is not (or is no longer) authenticated, or when the server reports
 * the gateway disabled or absent. GitHub results through the gateway --
 * not-found, rate limits, upstream failures -- are returned as-is, never
 * retried directly.
 */
export function createGitHubGatewayTransport(
  options: GitHubGatewayFetcherOptions,
): {
  fetcher: typeof fetch
  /** Expected path: "gateway" with a live session, otherwise "direct".
   * Actual path: "gateway" only for a gateway-produced response. */
  rateLimitScope: RateLimitScope
} {
  const directFetch = (options.directFetch ?? globalThis.fetch).bind(globalThis)
  const now = options.now ?? Date.now
  const gatewayUrl = new URL(GATEWAY_PATH, options.previewApiBaseUrl)
  // Every direct GitHub request goes through here, including fallbacks
  // chosen after GitHubClient checked the gateway scope, so the direct
  // path's cooldown is enforced here as well.
  let directCooldownUntil = 0
  const direct = async (
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    if (directCooldownUntil > now()) {
      return rateLimitedResponse(directCooldownUntil, now)
    }
    const response = await directFetch(input, init)
    const cooldown = getRateLimitCooldown(response, now)
    if (cooldown) {
      directCooldownUntil = Math.max(directCooldownUntil, cooldown.getTime())
    }
    return response
  }
  const liveSession = async () => {
    const session = await options.getSession()
    return session && Date.parse(session.expiresAt) > now() ? session : null
  }

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== GITHUB_API_ORIGIN) return directFetch(input, init)

    const session = await liveSession()
    if (!session) return direct(input, init)

    const response = await directFetch(gatewayUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: `${url.pathname}${url.search}` }),
      signal: init?.signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    })

    const marker = response.headers.get(GATEWAY_HEADER)
    if (marker === "1") return response
    if (marker === "disabled" || response.status === 404) {
      // Server-side rollback, or a server that predates the gateway.
      await response.body?.cancel().catch(() => undefined)
      return direct(input, init)
    }
    if (response.status === 401) {
      // The Peephole session was rejected: drop it, exactly as the preview
      // clients do, and continue as an unauthenticated caller.
      await response.body?.cancel().catch(() => undefined)
      await options.clearSession()
      return direct(input, init)
    }
    // Preview-API infrastructure errors (413, 415, 500, ...) surface through
    // GitHubClient's normal "unavailable" mapping.
    return response
  }

  return {
    fetcher,
    rateLimitScope: {
      current: async () => ((await liveSession()) ? "gateway" : "direct"),
      of: (response) =>
        response.headers.get(GATEWAY_HEADER) === "1" ? "gateway" : "direct",
    },
  }
}

/** A local stand-in for a request withheld during the direct cooldown, in
 * the shape GitHubClient already maps to its rate-limited error. */
function rateLimitedResponse(until: number, now: () => number): Response {
  return new Response(JSON.stringify({ message: "rate limited" }), {
    status: 429,
    headers: {
      "retry-after": String(Math.max(1, Math.ceil((until - now()) / 1000))),
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.ceil(until / 1000)),
    },
  })
}
