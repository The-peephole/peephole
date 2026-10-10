import { vi } from "vitest"

export const SHA_A = "a".repeat(40)
export const SHA_B = "b".repeat(40)
export const SERVER_TOKEN = "ghp_server_owned_test_credential_000000"

export interface GitHubFixtureState {
  private: boolean
  /** null omits the field entirely. */
  visibility: "public" | "private" | "internal" | null
  /** `x-oauth-scopes` on the credential check; null omits the header. */
  scopes: string | null
  privateRepos: unknown[]
  remaining: number
  resetEpochSeconds: number
}

/**
 * A fake api.github.com for the acme/fullstack fixture repository (React/Vite
 * frontend + Express/pg backend). Responses carry extra GitHub fields so
 * tests can prove the gateway forwards only what the client reads.
 */
export function createGitHubFixture(state: Partial<GitHubFixtureState> = {}) {
  const fixture: GitHubFixtureState = {
    private: false,
    visibility: "public",
    scopes: "",
    privateRepos: [],
    remaining: 4_000,
    resetEpochSeconds: 4_102_444_800,
    ...state,
  }
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const respond = (value: unknown, headers: Record<string, string> = {}) =>
      jsonResponse(value, {
        "x-ratelimit-remaining": String(fixture.remaining),
        "x-ratelimit-reset": String(fixture.resetEpochSeconds),
        ...headers,
      })

    if (url.pathname === "/user/repos") {
      return respond(
        fixture.privateRepos,
        fixture.scopes === null ? {} : { "x-oauth-scopes": fixture.scopes },
      )
    }
    if (url.pathname === "/repos/acme/fullstack") {
      return respond({
        id: 7,
        node_id: "R_secret_internal_id",
        name: "fullstack",
        owner: { login: "acme", id: 1, site_admin: false },
        default_branch: "main",
        homepage: null,
        private: fixture.private,
        ...(fixture.visibility === null
          ? {}
          : { visibility: fixture.visibility }),
        permissions: { admin: true, push: true, pull: true },
      })
    }
    if (url.pathname === "/repos/acme/fullstack/branches/main") {
      return respond({ name: "main", commit: { sha: SHA_A, url: "x" } })
    }
    if (url.pathname === "/repos/acme/fullstack/branches/feature%2Fnew-ui") {
      return respond({ name: "feature/new-ui", commit: { sha: SHA_B } })
    }
    if (url.pathname === "/repos/acme/fullstack/branches") {
      return respond([
        { name: "main", commit: { sha: SHA_A }, protected: true },
        { name: "feature/new-ui", commit: { sha: SHA_B }, protected: false },
      ])
    }
    if (url.pathname === "/repos/acme/fullstack/deployments") {
      return respond([])
    }
    if (url.pathname === "/repos/acme/fullstack/contents") {
      return respond([
        entry("file", "package.json", "package.json", 75),
        entry("dir", "frontend", "frontend", 0),
        entry("dir", "backend", "backend", 0),
      ])
    }
    if (url.pathname === "/repos/acme/fullstack/contents/frontend") {
      return respond([
        entry("file", "package.json", "frontend/package.json", 80),
        entry("file", "vite.config.ts", "frontend/vite.config.ts", 20),
      ])
    }

    const path = decodeURIComponent(
      url.pathname.replace("/repos/acme/fullstack/contents/", ""),
    )
    const content = FILES[path]
    if (content === undefined) {
      return new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
      })
    }
    const bytes = new TextEncoder().encode(content)
    return respond({
      type: "file",
      path,
      size: bytes.byteLength,
      encoding: "base64",
      content: btoa(String.fromCharCode(...bytes)),
      sha: "f".repeat(40),
      download_url: "https://raw.githubusercontent.com/acme/fullstack/x",
    })
  })
  return { fixture, fetcher }
}

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({
    private: true,
    workspaces: ["frontend", "backend"],
  }),
  "frontend/package.json": JSON.stringify({
    name: "frontend",
    scripts: { build: "vite build" },
    dependencies: { react: "latest", vite: "latest" },
  }),
  "frontend/vite.config.ts": "export default {}",
  "backend/package.json": JSON.stringify({
    name: "backend",
    scripts: { start: "node index.js" },
    dependencies: { express: "latest", pg: "latest" },
  }),
  "backend/.env.example": "DATABASE_URL=postgres://example",
  "backend/package-lock.json": "{}",
}

function entry(type: "file" | "dir", name: string, path: string, size: number) {
  return { type, name, path, size, sha: "e".repeat(40), url: "x", git_url: "y" }
}

export function jsonResponse(
  value: unknown,
  headers: Record<string, string> = {},
  status = 200,
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}
