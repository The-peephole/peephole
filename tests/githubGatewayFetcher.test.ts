import { describe, expect, it, vi } from "vitest"

import { BuildTargetAnalysisService } from "../core/analyzer/buildTargetAnalysisService"
import { RepositoryAnalysisService } from "../core/analyzer/repositoryAnalysisService"
import { BackendCandidateLoader } from "../core/github/backendCandidateLoader"
import { GitHubApiError, GitHubClient } from "../core/github/client"
import { createGitHubGatewayFetcher } from "../core/github/gatewayFetcher"
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
    gateway?: GitHubGateway
    gatewayResponse?: () => Response
  } = {},
) {
  const upstream = createGitHubFixture()
  const direct = createGitHubFixture()
  const gateway =
    options.gateway ??
    new GitHubGateway({ token: SERVER_TOKEN, fetcher: upstream.fetcher })
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
      if (options.gatewayResponse) return options.gatewayResponse()
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
    const fetcher = createGitHubGatewayFetcher({
      previewApiBaseUrl: API_BASE,
      getSession: async () => current,
      clearSession,
      directFetch: network,
    })
    return {
      client: new GitHubClient({ fetcher, requestCache: {} }),
      clearSession,
      network,
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

  async function measure(session: StoredPreviewSession | null) {
    const env = environment()
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
