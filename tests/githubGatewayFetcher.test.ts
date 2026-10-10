import { describe, expect, it, vi } from "vitest"

import { BuildTargetAnalysisService } from "../core/analyzer/buildTargetAnalysisService"
import { RepositoryAnalysisService } from "../core/analyzer/repositoryAnalysisService"
import { BackendCandidateLoader } from "../core/github/backendCandidateLoader"
import { GitHubApiError, GitHubClient } from "../core/github/client"
import { createGitHubGatewayTransport } from "../core/github/gatewayFetcher"
import { KnownRepositoryFilesLoader } from "../core/github/knownFiles"
import { RepositoryLiveDeploymentCache } from "../core/github/liveDeploymentCache"
import { RepositoryMetadataCache } from "../core/github/repositoryMetadataCache"
import { RepositoryDeploymentsLoader } from "../core/github/repositoryDeploymentsLoader"
import { DEFAULT_REPOSITORY_REF } from "../core/github/repositoryRef"
import { RepositoryStructureLoader } from "../core/github/repositoryStructureLoader"
import { TargetKnownFilesLoader } from "../core/github/targetKnownFiles"
import type { StoredPreviewSession } from "../core/preview/sessionStorage"
import {
  GITHUB_GATEWAY_HEADER,
  GITHUB_GATEWAY_PATH,
  GitHubGateway,
} from "../services/preview-api/githubGateway"
import type { PreviewHttpResponse } from "../services/preview-api/http"
import {
  SERVER_TOKEN,
  SHA_A,
  createGitHubFixture,
} from "./support/githubGatewayFixture"

const API_BASE = "https://api.peephole.test/"
const repository = { owner: "acme", repo: "fullstack" }

function liveSession(subject = "alice"): StoredPreviewSession {
  return {
    token: `session-${subject}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
}

/**
 * Wires an extension-side fetcher to an in-process gateway. The gateway's
 * own upstream (server credential) and the extension's direct GitHub path
 * use separate fake GitHub hosts so every request is attributable.
 */
function environment(
  options: {
    /** Overrides the gateway answer; returning undefined uses the real one. */
    gatewayResponse?: () => Response | undefined
    visibilityTtlMs?: number
  } = {},
) {
  const upstream = createGitHubFixture()
  const direct = createGitHubFixture()
  const gateway = new GitHubGateway({
    token: SERVER_TOKEN,
    fetcher: upstream.fetcher,
    visibilityTtlMs: options.visibilityTtlMs,
  })
  const gatewayCalls: Array<{ body: unknown; authorization: string | null }> =
    []

  function extension(session: StoredPreviewSession | null) {
    let current = session
    const clearSession = vi.fn(async () => {
      current = null
    })
    const network = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin === "https://api.github.com") {
        return direct.fetcher(input, init)
      }
      expect(url.href).toBe(new URL(GITHUB_GATEWAY_PATH, API_BASE).href)
      const authorization = new Headers(init?.headers).get("authorization")
      const body = JSON.parse(String(init?.body)) as unknown
      gatewayCalls.push({ body, authorization })
      const override = options.gatewayResponse?.()
      if (override) return override
      const requester = {
        subject: `github:${authorization ?? "anonymous"}`,
        ip: "203.0.113.9",
      }
      return toResponse(
        await gateway.handle({
          method: "POST",
          path: GITHUB_GATEWAY_PATH,
          headers: {},
          body,
          requester,
        }),
      )
    })
    const transport = createGitHubGatewayTransport({
      previewApiBaseUrl: API_BASE,
      getSession: async () => current,
      clearSession,
      directFetch: network,
    })
    return {
      client: new GitHubClient({ ...transport, requestCache: {} }),
      clearSession,
      network,
      setSession: (next: StoredPreviewSession | null) => {
        current = next
      },
    }
  }

  return { upstream, direct, gateway, gatewayCalls, extension }
}

function toResponse(response: PreviewHttpResponse): Response {
  return new Response(JSON.stringify(response.body), {
    status: response.status,
    headers: response.headers,
  })
}

describe("extension GitHub gateway fetcher", () => {
  it("keeps the direct unauthenticated path when signed out or expired", async () => {
    for (const session of [
      null,
      { token: "old", expiresAt: new Date(Date.now() - 1).toISOString() },
    ]) {
      const env = environment()
      const { client } = env.extension(session)

      await client.getRepositoryMetadata(repository)

      expect(env.gatewayCalls).toHaveLength(0)
      expect(env.direct.fetcher).toHaveBeenCalled()
      for (const [, init] of env.direct.fetcher.mock.calls) {
        expect(new Headers(init?.headers).has("authorization")).toBe(false)
      }
    }
  })

  it("routes a signed-in user through the gateway with only the session", async () => {
    const env = environment()
    const { client } = env.extension(liveSession())

    const metadata = await client.getRepositoryMetadata(repository)

    expect(metadata).toMatchObject({ repositoryId: 7, commitSha: SHA_A })
    expect(env.direct.fetcher).not.toHaveBeenCalled()
    expect(env.gatewayCalls).toEqual([
      {
        body: { path: "/repos/acme/fullstack" },
        authorization: "Bearer session-alice",
      },
      {
        body: { path: "/repos/acme/fullstack/branches/main" },
        authorization: "Bearer session-alice",
      },
    ])
    expect(JSON.stringify(env.gatewayCalls)).not.toContain(SERVER_TOKEN)
  })

  it("drops a rejected session and continues unauthenticated", async () => {
    const env = environment({
      gatewayResponse: () =>
        new Response(JSON.stringify({ error: { code: "UNAUTHORIZED" } }), {
          status: 401,
        }),
    })
    const { client, clearSession } = env.extension(liveSession())

    await client.getRepositoryMetadata(repository)

    expect(clearSession).toHaveBeenCalledOnce()
    expect(env.gatewayCalls).toHaveLength(1)
    expect(env.direct.fetcher).toHaveBeenCalledTimes(2)
  })

  it.each([
    [
      "operator-disabled gateway",
      () =>
        new Response("{}", {
          status: 503,
          headers: { [GITHUB_GATEWAY_HEADER]: "disabled" },
        }),
    ],
    [
      "server without the gateway route",
      () => new Response('{"error":{"code":"NOT_FOUND"}}', { status: 404 }),
    ],
  ])("falls back directly for a %s", async (_label, gatewayResponse) => {
    const env = environment({ gatewayResponse })
    const { client, clearSession } = env.extension(liveSession())

    await expect(
      client.getRepositoryMetadata(repository),
    ).resolves.toMatchObject({ repositoryId: 7 })
    expect(clearSession).not.toHaveBeenCalled()
    expect(env.direct.fetcher).toHaveBeenCalled()
  })

  it("never retries gateway GitHub results directly", async () => {
    const notFound = environment({
      gatewayResponse: () =>
        new Response('{"message":"Not Found"}', {
          status: 404,
          headers: { [GITHUB_GATEWAY_HEADER]: "1" },
        }),
    })
    await expect(
      notFound
        .extension(liveSession())
        .client.getRepositoryMetadata(repository),
    ).rejects.toMatchObject({ code: "not-found" })
    expect(notFound.direct.fetcher).not.toHaveBeenCalled()

    const limited = environment({
      gatewayResponse: () =>
        new Response('{"message":"limit"}', {
          status: 429,
          headers: {
            [GITHUB_GATEWAY_HEADER]: "1",
            "retry-after": "30",
            "x-ratelimit-remaining": "0",
          },
        }),
    })
    const error = await limited
      .extension(liveSession())
      .client.getRepositoryMetadata(repository)
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitHubApiError)
    expect(error).toMatchObject({ code: "rate-limited", status: 429 })
    expect((error as GitHubApiError).retryAt).toBeInstanceOf(Date)
    expect(limited.direct.fetcher).not.toHaveBeenCalled()

    const infra = environment({
      gatewayResponse: () => new Response("{}", { status: 500 }),
    })
    await expect(
      infra.extension(liveSession()).client.getRepositoryMetadata(repository),
    ).rejects.toMatchObject({ code: "unavailable" })
    expect(infra.direct.fetcher).not.toHaveBeenCalled()
  })

  it("does not let a direct-path cooldown block the gateway after sign-in", async () => {
    const env = environment()
    const { client, setSession } = env.extension(null)
    env.direct.fetcher.mockImplementationOnce(
      async () =>
        new Response("{}", { status: 429, headers: { "retry-after": "600" } }),
    )

    await expect(
      client.getRepositoryMetadata(repository),
    ).rejects.toMatchObject({ code: "rate-limited" })
    setSession(liveSession())

    await expect(
      client.getRepositoryMetadata(repository),
    ).resolves.toMatchObject({ repositoryId: 7 })
    expect(env.gatewayCalls.length).toBeGreaterThan(0)
  })

  it("does not let a gateway cooldown block the direct path after sign-out", async () => {
    let limited = true
    const env = environment()
    const gateway = env.gateway
    const { client, setSession, network } = env.extension(liveSession())
    const base = network.getMockImplementation()!
    network.mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin !== "https://api.github.com" && limited) {
        limited = false
        return new Response("{}", {
          status: 429,
          headers: { [GITHUB_GATEWAY_HEADER]: "1", "retry-after": "600" },
        })
      }
      return base(input, init)
    })
    void gateway

    await expect(
      client.getRepositoryMetadata(repository),
    ).rejects.toMatchObject({ code: "rate-limited" })
    setSession(null)

    await expect(
      client.getRepositoryMetadata(repository),
    ).resolves.toMatchObject({ repositoryId: 7 })
    expect(env.direct.fetcher).toHaveBeenCalled()
  })

  it("keeps each path's own cooldown in force", async () => {
    const env = environment()
    const { client, setSession } = env.extension(null)
    env.direct.fetcher.mockImplementationOnce(
      async () =>
        new Response("{}", { status: 429, headers: { "retry-after": "600" } }),
    )
    await expect(
      client.getRepositoryMetadata(repository),
    ).rejects.toMatchObject({ code: "rate-limited" })
    const directCalls = env.direct.fetcher.mock.calls.length

    setSession(liveSession())
    await client.getRepositoryMetadata(repository)
    setSession(null)

    await expect(
      client.listRepositoryBranches(repository),
    ).rejects.toMatchObject({ code: "rate-limited" })
    expect(env.direct.fetcher.mock.calls.length).toBe(directCalls)
  })

  describe("fallback responses keep the cooldown on the path that produced them", () => {
    const directLimit = () =>
      new Response("{}", { status: 429, headers: { "retry-after": "600" } })
    const disabled = () =>
      new Response("{}", {
        status: 503,
        headers: { [GITHUB_GATEWAY_HEADER]: "disabled" },
      })
    const sessionRejected = () =>
      new Response('{"error":{"code":"UNAUTHORIZED"}}', { status: 401 })

    it.each([
      ["the gateway is disabled", disabled],
      ["the session is rejected", sessionRejected],
    ])(
      "a direct 429 after falling back because %s never blocks a working gateway",
      async (_label, fallbackCause) => {
        let gatewayDown = true
        const env = environment({
          gatewayResponse: () => (gatewayDown ? fallbackCause() : undefined),
        })
        const { client, setSession } = env.extension(liveSession())
        env.direct.fetcher.mockImplementationOnce(async () => directLimit())

        await expect(
          client.getRepositoryMetadata(repository),
        ).rejects.toMatchObject({ code: "rate-limited" })

        gatewayDown = false
        setSession(liveSession())
        await expect(
          client.getRepositoryMetadata(repository),
        ).resolves.toMatchObject({ repositoryId: 7 })
      },
    )

    it.each([
      ["the gateway is disabled", disabled],
      ["the session is rejected", sessionRejected],
    ])(
      "the direct cooldown still holds for direct requests after %s",
      async (_label, fallbackCause) => {
        const env = environment({ gatewayResponse: fallbackCause })
        const { client, setSession } = env.extension(liveSession())
        env.direct.fetcher.mockImplementationOnce(async () => directLimit())
        await expect(
          client.getRepositoryMetadata(repository),
        ).rejects.toMatchObject({ code: "rate-limited" })
        const directCalls = env.direct.fetcher.mock.calls.length

        // Signed out: plain direct path.
        setSession(null)
        await expect(
          client.listRepositoryBranches(repository),
        ).rejects.toMatchObject({ code: "rate-limited" })
        // Signed in but still falling back: also no direct request.
        setSession(liveSession())
        await expect(
          client.listRepositoryBranches(repository),
        ).rejects.toMatchObject({ code: "rate-limited" })

        expect(env.direct.fetcher.mock.calls.length).toBe(directCalls)
      },
    )
  })

  it("keeps cancelled gateway requests out of the extension cache", async () => {
    const pending: Array<(response: Response) => void> = []
    const env = environment({
      gatewayResponse: () =>
        // Never used: replaced below to control completion.
        new Response("{}"),
    })
    const { client, network } = env.extension(liveSession())
    network.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve)
        }),
    )
    const abort = new AbortController()
    const path = "frontend/package.json"
    const metadata = {
      repositoryId: 7,
      owner: "acme",
      repo: "fullstack",
      defaultBranch: "main",
      commitSha: SHA_A,
      homepage: null,
    }

    const first = client.getRepositoryTextFile(
      metadata,
      path,
      1024,
      abort.signal,
    )
    const rejection = expect(first).rejects.toMatchObject({
      name: "AbortError",
    })
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    abort.abort()
    await rejection
    pending[0]?.(fileResponse(path, '{"late":true}'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const next = client.getRepositoryTextFile(metadata, path, 1024)
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    pending[1]?.(fileResponse(path, '{"fresh":true}'))
    await expect(next).resolves.toBe('{"fresh":true}')
  })
})

describe("GitHub request counts: direct vs. gateway", () => {
  async function scenario(client: GitHubClient) {
    const metadataCache = new RepositoryMetadataCache(client)
    const analysis = new RepositoryAnalysisService(
      metadataCache.load,
      new KnownRepositoryFilesLoader(client),
      new RepositoryStructureLoader(client),
      new BackendCandidateLoader(client),
    )
    const targets = new BuildTargetAnalysisService(
      new TargetKnownFilesLoader(client),
    )
    const deployments = new RepositoryLiveDeploymentCache(
      new RepositoryDeploymentsLoader(client),
    )
    const defaultTarget = { repository, ref: DEFAULT_REPOSITORY_REF }
    return {
      cold: () =>
        Promise.all([
          analysis.load(defaultTarget),
          client.listRepositoryBranches(repository),
          deployments.load(repository),
        ]),
      rootFrontendRoot: async (
        metadata: Parameters<typeof targets.load>[0],
      ) => {
        await targets.load(metadata, { sourceRoot: "." })
        await targets.load(metadata, { sourceRoot: "frontend" })
        await targets.load(metadata, { sourceRoot: "." })
      },
      branch: () =>
        analysis.load({
          repository,
          ref: { kind: "branch", name: "feature/new-ui" },
        }),
    }
  }

  async function measure(
    session: StoredPreviewSession | null,
    visibilityTtlMs?: number,
  ) {
    const env = environment({ visibilityTtlMs })
    const counts: Record<
      string,
      { direct: number; gateway: number; upstream: number }
    > = {}
    const snapshot = (label: string) => {
      counts[label] = {
        direct: env.direct.fetcher.mock.calls.length,
        gateway: env.gatewayCalls.length,
        upstream: env.upstream.fetcher.mock.calls.length,
      }
    }

    const alice = await scenario(env.extension(session).client)
    const [coldAnalysis] = await alice.cold()
    snapshot("1-cold")
    await alice.cold()
    snapshot("2-warm")
    await alice.rootFrontendRoot(coldAnalysis.repository)
    snapshot("3-root-frontend-root")
    await alice.branch()
    snapshot("4-branch-change")

    // A second user (separate extension cache) analyzing the same repository.
    const bob = await scenario(
      env.extension(session && liveSession("bob")).client,
    )
    await bob.cold()
    snapshot("5-second-user-cold")

    // Two more users at the same moment.
    const carol = await scenario(
      env.extension(session && liveSession("carol")).client,
    )
    const dave = await scenario(
      env.extension(session && liveSession("dave")).client,
    )
    await Promise.all([carol.cold(), dave.cold()])
    snapshot("6-concurrent-two-users")
    return counts
  }

  it("matches the PR #49 baseline when signed out", async () => {
    expect(await measure(null)).toEqual({
      "1-cold": { direct: 14, gateway: 0, upstream: 0 },
      "2-warm": { direct: 14, gateway: 0, upstream: 0 },
      "3-root-frontend-root": { direct: 16, gateway: 0, upstream: 0 },
      "4-branch-change": { direct: 27, gateway: 0, upstream: 0 },
      "5-second-user-cold": { direct: 41, gateway: 0, upstream: 0 },
      "6-concurrent-two-users": { direct: 69, gateway: 0, upstream: 0 },
    })
  })

  // Upstream = 1 credential check + one call per distinct operation; a
  // second or concurrent user re-fetches only uncached deployment evidence.
  it("moves every signed-in request to the gateway and shares upstream work", async () => {
    expect(await measure(liveSession())).toEqual({
      "1-cold": { direct: 0, gateway: 14, upstream: 15 },
      "2-warm": { direct: 0, gateway: 14, upstream: 15 },
      "3-root-frontend-root": { direct: 0, gateway: 16, upstream: 17 },
      "4-branch-change": { direct: 0, gateway: 27, upstream: 28 },
      "5-second-user-cold": { direct: 0, gateway: 41, upstream: 29 },
      "6-concurrent-two-users": { direct: 0, gateway: 69, upstream: 30 },
    })
  })

  // Cost of the rejected "re-check visibility on every request" policy.
  it("measures re-checking visibility on every gateway request", async () => {
    expect(await measure(liveSession(), 0)).toEqual({
      "1-cold": { direct: 0, gateway: 14, upstream: 26 },
      "2-warm": { direct: 0, gateway: 14, upstream: 26 },
      "3-root-frontend-root": { direct: 0, gateway: 16, upstream: 30 },
      "4-branch-change": { direct: 0, gateway: 27, upstream: 52 },
      "5-second-user-cold": { direct: 0, gateway: 41, upstream: 65 },
      "6-concurrent-two-users": { direct: 0, gateway: 69, upstream: 78 },
    })
  })
})

describe("Public -> Private transition exposure", () => {
  it("bounds new exposure by the server visibility TTL; delivered data stays in that browser", async () => {
    let time = Date.parse("2026-10-10T00:00:00Z")
    const now = () => time
    const upstream = createGitHubFixture()
    const gateway = new GitHubGateway({
      token: SERVER_TOKEN,
      fetcher: upstream.fetcher,
      now,
    })
    const user = (subject: string) => {
      const network = vi.fn<typeof fetch>(async (_input, init) =>
        toResponse(
          await gateway.handle({
            method: "POST",
            path: GITHUB_GATEWAY_PATH,
            headers: {},
            body: JSON.parse(String(init?.body)) as unknown,
            requester: { subject, ip: `198.51.100.${subject.length}` },
          }),
        ),
      )
      const transport = createGitHubGatewayTransport({
        previewApiBaseUrl: API_BASE,
        getSession: async () => ({
          token: subject,
          expiresAt: "2099-01-01T00:00:00.000Z",
        }),
        clearSession: async () => undefined,
        directFetch: network,
        now,
      })
      return {
        client: new GitHubClient({ ...transport, requestCache: {}, now }),
        network,
      }
    }
    const metadata = {
      repositoryId: 7,
      owner: "acme",
      repo: "fullstack",
      defaultBranch: "main",
      commitSha: SHA_A,
      homepage: null,
    }
    const path = "frontend/package.json"
    const fileUpstreamCalls = () =>
      upstream.fetcher.mock.calls.filter(([input]) =>
        String(input).includes("/contents/frontend/package.json"),
      ).length
    const alice = user("alice")

    // 1-2. A reads a public file; the server cache now holds it.
    await expect(
      alice.client.getRepositoryTextFile(metadata, path, 4096),
    ).resolves.toContain("frontend")
    expect(fileUpstreamCalls()).toBe(1)

    // 3. The repository turns private.
    upstream.fixture.private = true
    upstream.fixture.visibility = "private"

    // 4. B, who never saw it, still receives it inside the 30 s window.
    time += 29_000
    const bob = user("bob")
    await expect(
      bob.client.getRepositoryTextFile(metadata, path, 4096),
    ).resolves.toContain("frontend")
    expect(fileUpstreamCalls()).toBe(1)

    // 5. After the visibility TTL nobody new receives it.
    time += 1_001
    const carol = user("carol")
    await expect(
      carol.client.getRepositoryTextFile(metadata, path, 4096),
    ).resolves.toBeNull()
    await expect(
      carol.client.getRepositoryMetadata({ owner: "acme", repo: "fullstack" }),
    ).rejects.toMatchObject({ code: "not-found" })

    // 6. A's background cache keeps what A already received, with no
    // request at all; any fresh repository lookup is refused.
    time += 60 * 60_000
    const aliceRequests = alice.network.mock.calls.length
    await expect(
      alice.client.getRepositoryTextFile(metadata, path, 4096),
    ).resolves.toContain("frontend")
    expect(alice.network.mock.calls.length).toBe(aliceRequests)
    await expect(
      alice.client.getRepositoryMetadata({ owner: "acme", repo: "fullstack" }),
    ).rejects.toMatchObject({ code: "not-found" })
  })
})

function fileResponse(path: string, content: string): Response {
  const bytes = new TextEncoder().encode(content)
  return new Response(
    JSON.stringify({
      type: "file",
      path,
      size: bytes.byteLength,
      encoding: "base64",
      content: btoa(String.fromCharCode(...bytes)),
    }),
    { status: 200, headers: { [GITHUB_GATEWAY_HEADER]: "1" } },
  )
}
