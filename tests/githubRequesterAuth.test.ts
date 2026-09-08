import type { IncomingMessage } from "node:http"
import { describe, expect, it, vi } from "vitest"

import { GitHubRequesterAuth } from "../services/preview-api/githubRequesterAuth"
import { HttpIngressError } from "../services/preview-api/nodeHttpServer"

describe("GitHubRequesterAuth", () => {
  it("resolves a valid bearer token to a stable, prefixed subject", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ id: 42, login: "octocat" }))
    const auth = new GitHubRequesterAuth({ fetcher })

    const requester = await auth.resolve(fakeRequest("Bearer ghp_valid"))

    expect(requester).toEqual({ subject: "github:42", ip: "203.0.113.5" })
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]!
    expect(String(url)).toBe("https://api.github.com/user")
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer ghp_valid",
    )
  })

  it("rejects a missing Authorization header without calling GitHub", async () => {
    const fetcher = vi.fn<typeof fetch>()
    const auth = new GitHubRequesterAuth({ fetcher })

    await expect(auth.resolve(fakeRequest(undefined))).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("rejects a token GitHub reports as invalid", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 401 }))
    const auth = new GitHubRequesterAuth({ fetcher })

    await expect(
      auth.resolve(fakeRequest("Bearer ghp_revoked")),
    ).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" })
  })

  it("surfaces a GitHub outage as a retryable error, not an auth failure", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("boom"))
    const auth = new GitHubRequesterAuth({ fetcher })

    await expect(
      auth.resolve(fakeRequest("Bearer ghp_valid")),
    ).rejects.toMatchObject({ status: 503, code: "INTERNAL_ERROR" })
  })

  it("caches a verified token so a repeated request does not re-call GitHub", async () => {
    // A fresh Response per call: Response.json() can only be read once,
    // and mockResolvedValue would otherwise hand back the same consumed
    // instance on the second (cache-busting) call.
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(jsonResponse({ id: 7 })))
    let now = Date.parse("2026-01-01T00:00:00.000Z")
    const auth = new GitHubRequesterAuth({
      fetcher,
      now: () => new Date(now),
    })

    await auth.resolve(fakeRequest("Bearer ghp_valid"))
    await auth.resolve(fakeRequest("Bearer ghp_valid"))
    expect(fetcher).toHaveBeenCalledOnce()

    now += 6 * 60_000 // past the 5-minute default TTL
    await auth.resolve(fakeRequest("Bearer ghp_valid"))
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("verifies distinct tokens independently, never mixing up their identities", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_, init) => {
      const auth = (init?.headers as Record<string, string>).Authorization
      return Promise.resolve(
        jsonResponse({ id: auth === "Bearer ghp_a" ? 1 : 2 }),
      )
    })
    const auth = new GitHubRequesterAuth({ fetcher })

    const a = await auth.resolve(fakeRequest("Bearer ghp_a"))
    const b = await auth.resolve(fakeRequest("Bearer ghp_b"))

    expect(a.subject).toBe("github:1")
    expect(b.subject).toBe("github:2")
  })

  it("throws HttpIngressError instances usable by the HTTP ingress layer", async () => {
    const auth = new GitHubRequesterAuth({ fetcher: vi.fn<typeof fetch>() })

    await expect(auth.resolve(fakeRequest(undefined))).rejects.toBeInstanceOf(
      HttpIngressError,
    )
  })
})

function fakeRequest(authorization: string | undefined): IncomingMessage {
  return {
    headers: { authorization },
    socket: { remoteAddress: "203.0.113.5" },
  } as unknown as IncomingMessage
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}
