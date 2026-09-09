import { describe, expect, it, vi } from "vitest"

import {
  GitHubAppOAuth,
  GitHubAppOAuthError,
} from "../services/preview-api/githubAppOAuth"
import { PreviewSessionIssuer } from "../services/preview-api/previewSession"

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop"
const REDIRECT_URL = `https://${EXTENSION_ID}.chromiumapp.org/github`
const CALLBACK_URL = "https://api.example.test/v1/auth/github/callback"
const NOW = new Date("2026-09-09T00:00:00.000Z")
const VERIFIER = "v".repeat(43)
const SESSION_SECRET = "session-signing-secret-with-at-least-32-bytes"

describe("GitHubAppOAuth", () => {
  it("binds redirect, client nonce, and PKCE challenge into signed state", async () => {
    const auth = createAuth()
    const { authorizationUrl, state } = await begin(auth)
    const authorization = new URL(authorizationUrl)

    expect(authorization.origin + authorization.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    )
    expect(authorization.searchParams.get("client_id")).toBe("Iv1.test")
    expect(authorization.searchParams.get("redirect_uri")).toBe(CALLBACK_URL)
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256")

    const callback = new URL(
      await auth.completeCallback(
        `/v1/auth/github/callback?code=temporary-code&state=${encodeURIComponent(state)}`,
      ),
    )
    expect(callback.origin + callback.pathname).toBe(REDIRECT_URL)
    const fragment = new URLSearchParams(callback.hash.slice(1))
    expect(fragment.get("code")).toBe("temporary-code")
    expect(fragment.get("client_state")).toBe("n".repeat(43))
    expect(fragment.get("state")).toBe(state)
  })

  it("rejects unapproved redirect targets before contacting GitHub", async () => {
    const auth = createAuth()
    const challenge = await codeChallenge(VERIFIER)

    await expect(
      auth.createAuthorizationUrl(
        `/v1/auth/github/start?redirect_uri=${encodeURIComponent("https://ponmlkjihgfedcbaponmlkjihgfedcba.chromiumapp.org/github")}&client_state=${"n".repeat(43)}&code_challenge=${challenge}`,
      ),
    ).rejects.toMatchObject({ status: 400 })
  })

  it("rejects tampered and expired state", async () => {
    const auth = createAuth()
    const { state } = await begin(auth)

    await expect(
      auth.completeCallback(
        `/v1/auth/github/callback?code=x&state=${encodeURIComponent(`${state}x`)}`,
      ),
    ).rejects.toBeInstanceOf(GitHubAppOAuthError)

    const expired = createAuth({
      now: () => new Date(NOW.getTime() + 11 * 60_000),
    })
    await expect(
      expired.completeCallback(
        `/v1/auth/github/callback?code=x&state=${encodeURIComponent(state)}`,
      ),
    ).rejects.toThrow("expired")
  })

  it("exchanges the code server-side and issues github:<id>", async () => {
    const fetcher = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (url) => {
        if (String(url).includes("/login/oauth/access_token")) {
          return jsonResponse({ access_token: "ghu_server_only" })
        }
        return jsonResponse({ id: 42, login: "octocat" })
      })
    const auth = createAuth({ fetcher })
    const { state } = await begin(auth)
    const issuer = new PreviewSessionIssuer(SESSION_SECRET, { now: () => NOW })

    const session = await auth.issueSession(
      { code: "temporary-code", state, codeVerifier: VERIFIER },
      issuer,
    )

    expect(await issuer.verify(session.token)).toBe("github:42")
    expect(fetcher).toHaveBeenCalledTimes(2)
    const tokenRequest = fetcher.mock.calls[0]![1]!
    expect(String(tokenRequest.body)).toContain("github-client-secret-value")
    const userHeaders = fetcher.mock.calls[1]![1]!.headers as Record<
      string,
      string
    >
    expect(userHeaders.authorization).toBe("Bearer ghu_server_only")
    expect(JSON.stringify(session)).not.toContain("ghu_server_only")
  })

  it("rejects a verifier that does not match signed PKCE state", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>()
    const auth = createAuth({ fetcher })
    const { state } = await begin(auth)

    await expect(
      auth.issueSession(
        { code: "temporary-code", state, codeVerifier: "x".repeat(43) },
        new PreviewSessionIssuer(SESSION_SECRET),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("returns GitHub cancellation to the initiating extension", async () => {
    const auth = createAuth()
    const { state } = await begin(auth)
    const callback = new URL(
      await auth.completeCallback(
        `/v1/auth/github/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      ),
    )
    expect(new URLSearchParams(callback.hash.slice(1)).get("error")).toBe(
      "access_denied",
    )
  })
})

function createAuth(
  overrides: Partial<ConstructorParameters<typeof GitHubAppOAuth>[0]> = {},
): GitHubAppOAuth {
  return new GitHubAppOAuth({
    clientId: "Iv1.test",
    clientSecret: "github-client-secret-value",
    callbackUrl: CALLBACK_URL,
    allowedExtensionIds: [EXTENSION_ID],
    stateSigningSecret: "oauth-state-signing-secret-at-least-32-bytes",
    now: () => NOW,
    ...overrides,
  })
}

async function begin(auth: GitHubAppOAuth): Promise<{
  authorizationUrl: string
  state: string
}> {
  const challenge = await codeChallenge(VERIFIER)
  const authorizationUrl = await auth.createAuthorizationUrl(
    `/v1/auth/github/start?redirect_uri=${encodeURIComponent(REDIRECT_URL)}&client_state=${"n".repeat(43)}&code_challenge=${challenge}`,
  )
  return {
    authorizationUrl,
    state: new URL(authorizationUrl).searchParams.get("state")!,
  }
}

async function codeChallenge(verifier: string): Promise<string> {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ).toString("base64url")
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}
