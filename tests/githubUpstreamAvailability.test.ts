import { describe, expect, it } from "vitest"

import { GitHubApiError } from "../core/github/client"
import { classifyGitHubUpstreamError } from "../core/github/upstreamAvailability"

describe("classifyGitHubUpstreamError", () => {
  it("classifies rate-limited as unavailable and preserves retryAt as seconds", () => {
    const now = () => new Date("2026-09-21T10:00:00.000Z")
    const retryAt = new Date("2026-09-21T10:00:30.000Z")
    const error = new GitHubApiError(
      "rate-limited",
      "GitHub API rate limit reached.",
      403,
      retryAt,
    )

    expect(classifyGitHubUpstreamError(error, now)).toEqual({
      kind: "unavailable",
      retryAfterSeconds: 30,
    })
  })

  it("classifies network failures as unavailable with no retryAfterSeconds", () => {
    const error = new GitHubApiError("network", "GitHub could not be reached.")

    expect(classifyGitHubUpstreamError(error)).toEqual({
      kind: "unavailable",
      retryAfterSeconds: null,
    })
  })

  it("classifies unavailable failures as unavailable", () => {
    const error = new GitHubApiError(
      "unavailable",
      "GitHub request failed with status 502.",
      502,
    )

    expect(classifyGitHubUpstreamError(error)).toEqual({
      kind: "unavailable",
      retryAfterSeconds: null,
    })
  })

  it("classifies not-found as not-found", () => {
    const error = new GitHubApiError(
      "not-found",
      "This repository is unavailable or is not public.",
      404,
    )

    expect(classifyGitHubUpstreamError(error)).toEqual({ kind: "not-found" })
  })

  it("classifies a malformed successful GitHub response (status present) as unavailable", () => {
    const error = new GitHubApiError(
      "invalid-response",
      "GitHub returned repository data in an unexpected format.",
      200,
    )

    expect(classifyGitHubUpstreamError(error)).toEqual({
      kind: "unavailable",
      retryAfterSeconds: null,
    })
  })

  it("returns null for a local/client-side invalid-response (status null)", () => {
    const error = new GitHubApiError(
      "invalid-response",
      "The requested repository directory path is invalid.",
    )

    expect(classifyGitHubUpstreamError(error)).toBeNull()
  })

  it("omits retryAfterSeconds when retryAt has already passed", () => {
    const now = () => new Date("2026-09-21T10:00:00.000Z")
    const retryAt = new Date("2026-09-21T09:59:00.000Z")
    const error = new GitHubApiError(
      "rate-limited",
      "GitHub API rate limit reached.",
      429,
      retryAt,
    )

    expect(classifyGitHubUpstreamError(error, now)).toEqual({
      kind: "unavailable",
      retryAfterSeconds: null,
    })
  })

  it("returns null for a non-GitHubApiError value", () => {
    expect(classifyGitHubUpstreamError(new Error("boom"))).toBeNull()
    expect(classifyGitHubUpstreamError("boom")).toBeNull()
    expect(classifyGitHubUpstreamError(undefined)).toBeNull()
  })
})
