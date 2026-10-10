import { describe, expect, it, vi } from "vitest"

import {
  GITHUB_GATEWAY_HEADER,
  GITHUB_GATEWAY_PATH,
  GitHubGateway,
  disabledGitHubGatewayResponse,
} from "../services/preview-api/githubGateway"
import { parseGitHubGatewayPath } from "../services/preview-api/githubGatewayRoutes"
import type { PreviewHttpRequest } from "../services/preview-api/http"
import {
  SERVER_TOKEN,
  SHA_A,
  SHA_B,
  createGitHubFixture,
  jsonResponse,
} from "./support/githubGatewayFixture"

const ALICE = { subject: "github:1", ip: "203.0.113.1" }
const BOB = { subject: "github:2", ip: "203.0.113.2" }

function call(
  gateway: GitHubGateway,
  path: unknown,
  requester = ALICE,
  method: PreviewHttpRequest["method"] = "POST",
) {
  return gateway.handle({
    method,
    path: GITHUB_GATEWAY_PATH,
    headers: {},
    body: { path },
    requester,
  })
}

function setup(
  state: Parameters<typeof createGitHubFixture>[0] = {},
  options: Partial<ConstructorParameters<typeof GitHubGateway>[0]> = {},
) {
  let time = 1_000_000
  const { fixture, fetcher } = createGitHubFixture(state)
  const log = vi.fn<(message: string) => void>()
  const gateway = new GitHubGateway({
    token: SERVER_TOKEN,
    fetcher,
    now: () => time,
    log,
    ...options,
  })
  return {
    gateway,
    fetcher,
    fixture,
    log,
    advance: (ms: number) => {
      time += ms
    },
    upstreamPaths: () =>
      fetcher.mock.calls.map(([input]) => new URL(String(input)).pathname),
  }
}

const repoPath = "/repos/acme/fullstack"
const filePath = `/repos/acme/fullstack/contents/frontend%2Fpackage.json?ref=${SHA_A}`

describe("GitHubGateway", () => {
  it("serves a public repository with only the fields the client reads", async () => {
    const { gateway, fetcher } = setup()

    const response = await call(gateway, repoPath)

    expect(response.status).toBe(200)
    expect(response.headers[GITHUB_GATEWAY_HEADER]).toBe("1")
    expect(response.body).toEqual({
      id: 7,
      name: "fullstack",
      owner: { login: "acme" },
      default_branch: "main",
      homepage: null,
      private: false,
      visibility: "public",
    })
    const [url, init] = fetcher.mock.calls.at(-1)!
    expect(String(url)).toBe("https://api.github.com/repos/acme/fullstack")
    expect(init?.redirect).toBe("manual")
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${SERVER_TOKEN}`,
    )
  })

  it("filters file and directory payloads", async () => {
    const { gateway } = setup()

    const file = await call(gateway, filePath)
    const directory = await call(
      gateway,
      `/repos/acme/fullstack/contents?ref=${SHA_A}`,
    )

    expect(Object.keys(file.body as object).sort()).toEqual([
      "content",
      "encoding",
      "path",
      "size",
      "type",
    ])
    expect(directory.body).toContainEqual({
      type: "dir",
      name: "frontend",
      path: "frontend",
      size: 0,
    })
    expect(JSON.stringify(directory.body)).not.toContain("git_url")
  })

  it.each([
    ["private", { private: true, visibility: "private" as const }],
    ["internal", { private: true, visibility: "internal" as const }],
    ["missing visibility", { visibility: null }],
    ["inconsistent flags", { private: false, visibility: "private" as const }],
  ])(
    "answers 404 and returns no data for a %s repository",
    async (_label, state) => {
      const { gateway, upstreamPaths } = setup(state)

      for (const path of [repoPath, filePath, `${repoPath}/branches/main`]) {
        const response = await call(gateway, path)
        expect(response.status).toBe(404)
        expect(JSON.stringify(response.body)).not.toContain("fullstack")
      }
      // Content is never requested once visibility fails.
      expect(upstreamPaths()).not.toContain(
        "/repos/acme/fullstack/contents/frontend%2Fpackage.json",
      )
    },
  )

  it("stops serving cached immutable content after the repository turns private", async () => {
    const { gateway, fixture, advance, fetcher } = setup()
    expect((await call(gateway, filePath)).status).toBe(200)
    const callsAfterWarmup = fetcher.mock.calls.length

    fixture.private = true
    fixture.visibility = "private"
    // Within the visibility TTL the previously public answer is still used.
    expect((await call(gateway, filePath)).status).toBe(200)
    expect(fetcher.mock.calls.length).toBe(callsAfterWarmup)

    advance(30_001)
    const response = await call(gateway, filePath)
    expect(response.status).toBe(404)
    expect(response.body).toEqual({ message: "Not Found" })
  })

  it.each([
    "/repos/acme/fullstack/contents/%2e%2e%2f%2e%2e%2fuser?ref=" + SHA_A,
    "/repos/acme/fullstack/contents/../../user?ref=" + SHA_A,
    "/repos/acme/fullstack/contents/a%5Cb?ref=" + SHA_A,
    "/repos/acme/fullstack/contents/a%00b?ref=" + SHA_A,
    "/repos/acme/fullstack/contents//x?ref=" + SHA_A,
    "/repos/acme/fullstack/contents/x?ref=main",
    "/repos/acme/fullstack/contents/x?ref=" + SHA_A.toUpperCase(),
    "/repos/acme/fullstack/contents/x?ref=" + SHA_A + "&ref=" + SHA_B,
    "/repos/acme/fullstack/contents/x?ref=" + SHA_A + "&access_token=x",
    "/repos/acme/fullstack/contents/x",
    "/repos/acme/fullstack/branches/feature..x",
    "/repos/acme/fullstack/branches/a/b",
    "/repos/acme/fullstack/branches?per_page=1000&page=1",
    "/repos/acme/fullstack/branches?per_page=100&page=2",
    "/repos/acme/fullstack/deployments/0/statuses?per_page=30&page=1",
    "/repos/acme/fullstack/deployments/1/statuses?per_page=100&page=1",
    "/repos/acme/fullstack/collaborators",
    "/repos/acme/fullstack/actions/secrets",
    "/repos/acme/..",
    "/repos/acme/.",
    "/repos/-bad/fullstack",
    "/repos/acme/fullstack?",
    "/repos/acme/fullstack#x",
    "/user/repos",
    "/user",
    "//evil.example/repos/acme/fullstack",
    "https://evil.example/repos/acme/fullstack",
    "/repos/acme/fullstack/contents/x?ref=" + SHA_A + " ",
    "",
    42,
  ])(
    "rejects unsupported or unsafe input %s without any upstream call",
    async (path) => {
      const { gateway, fetcher } = setup()

      const response = await call(gateway, path)

      expect(response.status).toBe(400)
      expect(fetcher).not.toHaveBeenCalled()
    },
  )

  it("rejects extra body keys and non-POST methods", async () => {
    const { gateway, fetcher } = setup()

    const extra = await gateway.handle({
      method: "POST",
      path: GITHUB_GATEWAY_PATH,
      headers: {},
      body: { path: repoPath, url: "https://evil.example" },
      requester: ALICE,
    })
    const get = await call(gateway, repoPath, ALICE, "GET")

    expect(extra.status).toBe(400)
    expect(get.status).toBe(405)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("accepts every path shape the extension client produces", () => {
    expect(
      parseGitHubGatewayPath("/repos/acme/fullstack/branches/feature%2Fnew-ui"),
    ).toMatchObject({ kind: "branch", branch: "feature/new-ui" })
    expect(
      parseGitHubGatewayPath(
        `/repos/acme/fullstack/contents/frontend/src?ref=${SHA_A}`,
      ),
    ).toMatchObject({ kind: "contents", path: "frontend/src" })
    expect(parseGitHubGatewayPath(filePath)).toMatchObject({
      kind: "contents",
      path: "frontend/package.json",
    })
    expect(
      parseGitHubGatewayPath(
        "/repos/acme/fullstack/deployments/12/statuses?per_page=30&page=1",
      ),
    ).toMatchObject({ kind: "deployment-statuses", deploymentId: 12 })
  })

  it("never follows an upstream redirect", async () => {
    const { gateway, fetcher } = setup()
    // The credential check succeeds; the repository read is redirected.
    fetcher.mockImplementationOnce(async () =>
      jsonResponse([], { "x-oauth-scopes": "" }),
    )
    fetcher.mockImplementationOnce(
      async () =>
        new Response(null, {
          status: 301,
          headers: { location: "https://evil.example/" },
        }),
    )

    const response = await call(gateway, repoPath)

    expect(response.status).toBe(502)
    expect(
      fetcher.mock.calls.every(([, init]) => init?.redirect === "manual"),
    ).toBe(true)
    expect(
      fetcher.mock.calls.every(([url]) =>
        String(url).startsWith("https://api.github.com/"),
      ),
    ).toBe(true)
  })

  it("rejects an oversized upstream response", async () => {
    const { gateway, fetcher } = setup()
    const huge = "x".repeat(4 * 1024 * 1024 + 1)
    fetcher.mockImplementation(async (input) =>
      new URL(String(input)).pathname === "/user/repos"
        ? jsonResponse([], { "x-oauth-scopes": "" })
        : new Response(JSON.stringify({ padding: huge })),
    )

    const response = await call(gateway, repoPath)

    expect(response.status).toBe(502)
    expect(response.body).toEqual({ message: "GitHub response is too large." })
  })

  it("rejects malformed GitHub JSON", async () => {
    const { gateway, fetcher } = setup()
    fetcher.mockImplementation(async (input) =>
      new URL(String(input)).pathname === "/user/repos"
        ? jsonResponse([], { "x-oauth-scopes": "" })
        : new Response("{not json"),
    )

    expect((await call(gateway, repoPath)).status).toBe(502)
  })

  it("never exposes the server credential in responses or logs", async () => {
    const { gateway, fetcher, log } = setup()
    fetcher.mockImplementation(async (input) =>
      new URL(String(input)).pathname === "/user/repos"
        ? jsonResponse([], { "x-oauth-scopes": "" })
        : new Response(JSON.stringify({ message: "Bad credentials" }), {
            status: 401,
          }),
    )

    const responses = [
      await call(gateway, repoPath),
      await call(gateway, filePath),
      await call(gateway, "/bad"),
    ]

    const serialized = JSON.stringify([responses, log.mock.calls])
    expect(serialized).not.toContain(SERVER_TOKEN)
    expect(serialized).not.toContain("Bearer")
    expect(responses[0]?.status).toBe(503)
    expect(responses[0]?.headers[GITHUB_GATEWAY_HEADER]).toBe("disabled")
  })

  describe("credential guard", () => {
    it.each([
      ["a private-capable classic scope", { scopes: "repo" }],
      ["a deployment scope", { scopes: "public_repo, repo_deployment" }],
      ["a visible private repository", { privateRepos: [{ id: 9 }] }],
    ])("disables the gateway for %s", async (_label, state) => {
      const { gateway, upstreamPaths, log } = setup(state)

      const response = await call(gateway, repoPath)

      expect(response.status).toBe(503)
      expect(response.headers[GITHUB_GATEWAY_HEADER]).toBe("disabled")
      expect(upstreamPaths()).toEqual(["/user/repos"])
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("not proven public-only"),
      )
    })

    it("accepts a fine-grained token (no scope header) that sees no private repositories", async () => {
      const { gateway } = setup({ scopes: null })

      expect((await call(gateway, repoPath)).status).toBe(200)
    })

    it("fails closed when the check itself fails, then re-checks later", async () => {
      const { gateway, fetcher, advance } = setup()
      fetcher.mockImplementationOnce(async () => {
        throw new TypeError("network")
      })

      expect((await call(gateway, repoPath)).status).toBe(503)
      expect((await call(gateway, repoPath)).status).toBe(503)
      advance(60_001)
      expect((await call(gateway, repoPath)).status).toBe(200)
    })

    it("reports the operator-disabled state distinctly", () => {
      const response = disabledGitHubGatewayResponse()
      expect(response.status).toBe(503)
      expect(response.headers[GITHUB_GATEWAY_HEADER]).toBe("disabled")
    })
  })

  describe("rate limits and quota", () => {
    it("propagates a GitHub 429 and cools down without further upstream calls", async () => {
      const { gateway, fetcher, advance } = setup()
      await call(gateway, repoPath)
      fetcher.mockImplementationOnce(
        async () =>
          new Response(JSON.stringify({ message: "secondary" }), {
            status: 429,
            headers: { "retry-after": "120" },
          }),
      )

      const limited = await call(gateway, `${repoPath}/branches/main`)
      const callsAfterLimit = fetcher.mock.calls.length
      const blocked = await call(gateway, filePath)

      expect(limited.status).toBe(429)
      expect(limited.headers["retry-after"]).toBe("120")
      expect(limited.headers["x-ratelimit-remaining"]).toBe("0")
      expect(blocked.status).toBe(429)
      expect(fetcher.mock.calls.length).toBe(callsAfterLimit)

      advance(120_001)
      expect((await call(gateway, filePath)).status).toBe(200)
    })

    it("reports 429 to a caller whose queued upstream slot opens during a cooldown", async () => {
      const { gateway, fetcher } = setup(
        {},
        { limits: { maxConcurrentUpstream: 1 } },
      )
      await call(gateway, repoPath)
      let releaseFirst!: (response: Response) => void
      fetcher.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            releaseFirst = resolve
          }),
      )

      const first = call(gateway, filePath)
      await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"))
      const queued = call(gateway, filePath.replace(SHA_A, SHA_B))
      // Let the second request pass its pre-slot quota check and queue.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(fetcher).toHaveBeenCalledTimes(3)
      releaseFirst(
        new Response("{}", { status: 429, headers: { "retry-after": "60" } }),
      )

      expect((await first).status).toBe(429)
      const response = await queued
      expect(response.status).toBe(429)
      expect(response.headers["retry-after"]).toBeDefined()
    })

    it("treats a 403 with exhausted primary quota as rate-limited", async () => {
      const { gateway, fetcher } = setup()
      await call(gateway, repoPath)
      fetcher.mockImplementationOnce(
        async () =>
          new Response("{}", {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "4102444800",
            },
          }),
      )

      const response = await call(gateway, `${repoPath}/branches/main`)

      expect(response.status).toBe(429)
      expect(response.headers["x-ratelimit-reset"]).toBe("4102444800")
    })

    it("holds back the final primary quota for preview admission", async () => {
      const { gateway, fetcher } = setup({ remaining: 500 })

      // The credential check observes remaining=500 (== reserve).
      const response = await call(gateway, repoPath)

      expect(response.status).toBe(429)
      expect(fetcher).toHaveBeenCalledTimes(1)
    })

    it("limits each subject independently", async () => {
      const { gateway } = setup({}, { limits: { perSubject: 3 } })

      for (let index = 0; index < 3; index++) {
        expect((await call(gateway, repoPath, ALICE)).status).toBe(200)
      }
      const limited = await call(gateway, repoPath, ALICE)

      expect(limited.status).toBe(429)
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0)
      expect((await call(gateway, repoPath, BOB)).status).toBe(200)
    })

    it("limits a single IP across subjects", async () => {
      const { gateway } = setup({}, { limits: { perIp: 2 } })
      const sameIp = { subject: "github:3", ip: ALICE.ip }

      expect((await call(gateway, repoPath, ALICE)).status).toBe(200)
      expect((await call(gateway, repoPath, sameIp)).status).toBe(200)
      expect((await call(gateway, repoPath, BOB)).status).toBe(200)
      expect((await call(gateway, repoPath, ALICE)).status).toBe(429)
    })

    it("caps concurrent upstream requests", async () => {
      let inFlight = 0
      let peak = 0
      const { gateway, fetcher } = setup(
        {},
        { limits: { maxConcurrentUpstream: 2 } },
      )
      const base = fetcher.getMockImplementation()!
      fetcher.mockImplementation(async (input, init) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        return base(input, init)
      })
      await call(gateway, repoPath)

      const paths = [
        "package.json",
        "frontend%2Fpackage.json",
        "frontend%2Fvite.config.ts",
        "backend%2Fpackage.json",
        "backend%2F.env.example",
      ].map((file) => `${repoPath}/contents/${file}?ref=${SHA_A}`)
      const responses = await Promise.all(
        paths.map((path) => call(gateway, path)),
      )

      expect(responses.every((response) => response.status === 200)).toBe(true)
      expect(peak).toBeLessThanOrEqual(2)
    })
  })

  describe("shared cache", () => {
    it("shares exact-SHA content across users and isolates other SHAs", async () => {
      const { gateway, upstreamPaths } = setup()

      await call(gateway, filePath, ALICE)
      const afterAlice = upstreamPaths().length
      await call(gateway, filePath, BOB)
      expect(upstreamPaths().length).toBe(afterAlice)

      await call(gateway, filePath.replace(SHA_A, SHA_B), BOB)
      expect(upstreamPaths().length).toBe(afterAlice + 1)
    })

    it("deduplicates concurrent identical requests from several users", async () => {
      const { gateway, upstreamPaths } = setup()

      const responses = await Promise.all(
        [ALICE, BOB, ALICE, BOB].map((requester) =>
          call(gateway, filePath, requester),
        ),
      )

      expect(responses.map((response) => response.status)).toEqual([
        200, 200, 200, 200,
      ])
      expect(upstreamPaths()).toEqual([
        "/user/repos",
        "/repos/acme/fullstack",
        "/repos/acme/fullstack/contents/frontend/package.json",
      ])
    })

    it("re-reads a mutable branch head after its TTL", async () => {
      const { gateway, advance, upstreamPaths } = setup()
      const branch = `${repoPath}/branches/main`

      await call(gateway, branch)
      await call(gateway, branch)
      const count = upstreamPaths().filter((path) =>
        path.endsWith("/branches/main"),
      ).length
      advance(30_001)
      await call(gateway, branch)

      expect(count).toBe(1)
      expect(
        upstreamPaths().filter((path) => path.endsWith("/branches/main")),
      ).toHaveLength(2)
    })

    it("caches a missing file only briefly", async () => {
      const { gateway, advance, upstreamPaths } = setup()
      const missing = `${repoPath}/contents/missing.json?ref=${SHA_A}`

      expect((await call(gateway, missing)).status).toBe(404)
      expect((await call(gateway, missing)).status).toBe(404)
      advance(15_001)
      expect((await call(gateway, missing)).status).toBe(404)

      expect(
        upstreamPaths().filter((path) => path.endsWith("missing.json")),
      ).toHaveLength(2)
    })
  })
})
