import { GitHubApiError } from "./client"

/**
 * Neutral, HTTP-framework-agnostic classification of a `GitHubApiError`
 * encountered at a repository-plan resolver boundary. This module knows
 * nothing about Preview/BackendRuntime/FullStackPreview HTTP concepts --
 * each control plane converts this outcome into its own typed control
 * error, so the same upstream GitHub failure behaves consistently across
 * every admission surface without duplicating the classification itself.
 */
export type GitHubUpstreamOutcome =
  | { readonly kind: "unavailable"; readonly retryAfterSeconds: number | null }
  | { readonly kind: "not-found" }

/**
 * Returns `null` for anything that is not a recognized GitHub upstream
 * availability/identity signal -- including a client-side `invalid-response`
 * (`status === null`, e.g. an unsafe local path or oversized file) and any
 * non-`GitHubApiError` value. Callers must re-throw the original error in
 * that case so unexpected programming failures keep producing the existing
 * generic safe error response instead of being reclassified.
 */
export function classifyGitHubUpstreamError(
  error: unknown,
  now: () => Date = () => new Date(),
): GitHubUpstreamOutcome | null {
  if (!(error instanceof GitHubApiError)) {
    return null
  }

  switch (error.code) {
    case "rate-limited":
    case "network":
    case "unavailable":
      return {
        kind: "unavailable",
        retryAfterSeconds: toRetryAfterSeconds(error.retryAt, now),
      }
    case "not-found":
      return { kind: "not-found" }
    case "invalid-response":
      // A malformed *successful* GitHub HTTP response (a status is present)
      // is an upstream failure. `status === null` means local/client-side
      // validation (an unsafe path, an oversized file, a decoding failure)
      // -- never mistaken for an upstream outage.
      return error.status !== null
        ? { kind: "unavailable", retryAfterSeconds: null }
        : null
    default:
      return null
  }
}

function toRetryAfterSeconds(
  retryAt: Date | null,
  now: () => Date,
): number | null {
  if (!retryAt) return null
  const seconds = Math.ceil((retryAt.getTime() - now().getTime()) / 1000)
  return seconds > 0 ? seconds : null
}
