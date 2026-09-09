import { describe, expect, it, vi } from "vitest"

import {
  connectGitHub,
  GitHubConnectionError,
} from "../core/preview/githubConnection"

const REDIRECT_URL =
  "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/github"
const SESSION = {
  token: "peephole-session",
  expiresAt: "2099-01-01T00:00:00.000Z",
}

describe("connectGitHub", () => {
  it("uses launchWebAuthFlow and stores only the Peephole session", async () => {
    const saveSession = vi.fn().mockResolvedValue(undefined)
    const fetcher = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse(200, SESSION))
    const launchWebAuthFlow = vi.fn(async ({ url }: { url: string }) => {
      const start = new URL(url)
      const clientState = start.searchParams.get("client_state")
      expect(start.pathname).toBe("/v1/auth/github/start")
      expect(start.searchParams.get("redirect_uri")).toBe(REDIRECT_URL)
      expect(start.searchParams.get("code_challenge")).toHaveLength(43)
      return `${REDIRECT_URL}#code=temporary-code&state=signed-state&client_state=${clientState}`
    })

    await expect(
      connectGitHub("https://api.example.test/", {
        fetcher,
        getRedirectUrl: () => REDIRECT_URL,
        launchWebAuthFlow,
        randomBytes: () => new Uint8Array(32).fill(7),
        saveSession,
      }),
    ).resolves.toEqual(SESSION)

    expect(saveSession).toHaveBeenCalledWith(SESSION)
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body)) as Record<
      string,
      string
    >
    expect(body.code).toBe("temporary-code")
    expect(body.state).toBe("signed-state")
    expect(body.codeVerifier).toHaveLength(43)
    expect(JSON.stringify(body)).not.toContain("ghp_")
    expect(JSON.stringify(body)).not.toContain("ghu_")
  })

  it("rejects a callback with a mismatched client nonce", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>()
    await expect(
      connectGitHub("https://api.example.test/", {
        fetcher,
        getRedirectUrl: () => REDIRECT_URL,
        launchWebAuthFlow: async () =>
          `${REDIRECT_URL}#code=code&state=state&client_state=attacker`,
        randomBytes: () => new Uint8Array(32).fill(7),
      }),
    ).rejects.toThrow("state did not match")
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("rejects cancellation without persisting anything", async () => {
    const saveSession = vi.fn()
    await expect(
      connectGitHub("https://api.example.test/", {
        getRedirectUrl: () => REDIRECT_URL,
        launchWebAuthFlow: async () => undefined,
        randomBytes: () => new Uint8Array(32).fill(7),
        saveSession,
      }),
    ).rejects.toBeInstanceOf(GitHubConnectionError)
    expect(saveSession).not.toHaveBeenCalled()
  })
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}
