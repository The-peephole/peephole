import { describe, expect, it } from "vitest"

import { readGitHubAppOAuthConfig } from "../services/preview-api/githubAppOAuthConfig"

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop"
const validEnvironment = {
  PEEPHOLE_GITHUB_APP_CLIENT_ID: "Iv1.peephole-test",
  PEEPHOLE_GITHUB_APP_CLIENT_SECRET: "github-client-secret-value",
  PEEPHOLE_GITHUB_APP_CALLBACK_URL:
    "https://api.example.test/v1/auth/github/callback",
  PEEPHOLE_ALLOWED_EXTENSION_IDS: EXTENSION_ID,
  PEEPHOLE_GITHUB_OAUTH_STATE_SECRET:
    "oauth-state-signing-secret-at-least-32-bytes",
}

describe("readGitHubAppOAuthConfig", () => {
  it("reads server-only GitHub App OAuth configuration", () => {
    expect(readGitHubAppOAuthConfig(validEnvironment)).toEqual({
      clientId: "Iv1.peephole-test",
      clientSecret: "github-client-secret-value",
      callbackUrl: "https://api.example.test/v1/auth/github/callback",
      allowedExtensionIds: [EXTENSION_ID],
      stateSigningSecret: "oauth-state-signing-secret-at-least-32-bytes",
    })
  })

  it("accepts a bounded comma-separated Extension ID allowlist", () => {
    const second = "ponmlkjihgfedcbaponmlkjihgfedcba"
    expect(
      readGitHubAppOAuthConfig({
        ...validEnvironment,
        PEEPHOLE_ALLOWED_EXTENSION_IDS: `${EXTENSION_ID}, ${second}`,
      }).allowedExtensionIds,
    ).toEqual([EXTENSION_ID, second])
  })

  it.each([
    "PEEPHOLE_GITHUB_APP_CLIENT_ID",
    "PEEPHOLE_GITHUB_APP_CLIENT_SECRET",
    "PEEPHOLE_GITHUB_APP_CALLBACK_URL",
    "PEEPHOLE_ALLOWED_EXTENSION_IDS",
    "PEEPHOLE_GITHUB_OAUTH_STATE_SECRET",
  ] as const)("requires %s", (name) => {
    expect(() =>
      readGitHubAppOAuthConfig({ ...validEnvironment, [name]: undefined }),
    ).toThrow(name)
  })

  it("rejects callback URLs outside the fixed callback path or HTTPS", () => {
    expect(() =>
      readGitHubAppOAuthConfig({
        ...validEnvironment,
        PEEPHOLE_GITHUB_APP_CALLBACK_URL: "https://api.example.test/other",
      }),
    ).toThrow("/v1/auth/github/callback")
    expect(() =>
      readGitHubAppOAuthConfig({
        ...validEnvironment,
        PEEPHOLE_GITHUB_APP_CALLBACK_URL:
          "http://api.example.test/v1/auth/github/callback",
      }),
    ).toThrow("HTTPS")
  })

  it("rejects malformed, duplicate, or non-Chrome extension IDs", () => {
    for (const value of ["not-an-id", `${EXTENSION_ID},${EXTENSION_ID}`, ""]) {
      expect(() =>
        readGitHubAppOAuthConfig({
          ...validEnvironment,
          PEEPHOLE_ALLOWED_EXTENSION_IDS: value,
        }),
      ).toThrow("PEEPHOLE_ALLOWED_EXTENSION_IDS")
    }
  })
})
