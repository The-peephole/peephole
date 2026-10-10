import { describe, expect, it, vi } from "vitest"

import { BuildTargetAnalysisService } from "../core/analyzer/buildTargetAnalysisService"
import { RepositoryAnalysisService } from "../core/analyzer/repositoryAnalysisService"
import { BackendCandidateLoader } from "../core/github/backendCandidateLoader"
import { GitHubApiError, GitHubClient } from "../core/github/client"
import { KnownRepositoryFilesLoader } from "../core/github/knownFiles"
import { RepositoryLiveDeploymentCache } from "../core/github/liveDeploymentCache"
import { RepositoryMetadataCache } from "../core/github/repositoryMetadataCache"
import { RepositoryDeploymentsLoader } from "../core/github/repositoryDeploymentsLoader"
import { DEFAULT_REPOSITORY_REF } from "../core/github/repositoryRef"
import { RepositoryStructureLoader } from "../core/github/repositoryStructureLoader"
import { TargetKnownFilesLoader } from "../core/github/targetKnownFiles"
import type { RepositoryMetadata } from "../types/repository"

const SHA_A = "a".repeat(40)
const SHA_B = "b".repeat(40)
const repository = { owner: "acme", repo: "fullstack" }
const metadata: RepositoryMetadata = {
  repositoryId: 7,
  owner: "acme",
  repo: "fullstack",
  defaultBranch: "main",
  commitSha: SHA_A,
  homepage: null,
}

describe("GitHub request optimization", () => {
  it("measures cold, warm, Root -> Frontend -> Root, and branch-change requests", async () => {
    const fetcher = createFixtureFetcher()
    const client = new GitHubClient({ fetcher, requestCache: {} })
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
    const defaultTarget = {
      repository,
      ref: DEFAULT_REPOSITORY_REF,
    }

    const [coldAnalysis] = await Promise.all([
      analysis.load(defaultTarget),
      client.listRepositoryBranches(repository),
      deployments.load(repository),
    ])
    expect(fetcher).toHaveBeenCalledTimes(14)

    await Promise.all([
      analysis.load(defaultTarget),
      client.listRepositoryBranches(repository),
      deployments.load(repository),
    ])
    expect(fetcher).toHaveBeenCalledTimes(14)

    await targets.load(coldAnalysis.repository, { sourceRoot: "." })
    expect(fetcher).toHaveBeenCalledTimes(14)

    await targets.load(coldAnalysis.repository, { sourceRoot: "frontend" })
    expect(fetcher).toHaveBeenCalledTimes(16)

    await targets.load(coldAnalysis.repository, { sourceRoot: "." })
    expect(fetcher).toHaveBeenCalledTimes(16)

    await analysis.load({
      repository,
      ref: { kind: "branch", name: "feature/new-ui" },
    })
    expect(fetcher).toHaveBeenCalledTimes(27)
  })

  it("deduplicates a concurrent file read without sharing caller cancellation", async () => {
    let resolveResponse: ((response: Response) => void) | undefined
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve
        }),
    )
    const client = new GitHubClient({ fetcher, requestCache: {} })
    const cancelled = new AbortController()

    const first = client.getRepositoryTextFile(
      metadata,
      "package.json",
      1024,
      cancelled.signal,
    )
    const second = client.getRepositoryTextFile(metadata, "package.json", 1024)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    cancelled.abort()
    resolveResponse?.(fileResponse("package.json", "{}"))

    await expect(first).rejects.toMatchObject({ name: "AbortError" })
    await expect(second).resolves.toBe("{}")
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("keeps different commits isolated and reapplies each caller's byte limit", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(fileResponse("package.json", '{"name":"cached"}')),
    )
    const client = new GitHubClient({ fetcher, requestCache: {} })

    await expect(
      client.getRepositoryTextFile(metadata, "package.json", 1024),
    ).resolves.toContain("cached")
    await expect(
      client.getRepositoryTextFile(metadata, "package.json", 4),
    ).rejects.toMatchObject({ code: "invalid-response" })
    await client.getRepositoryTextFile(
      { ...metadata, commitSha: SHA_B },
      "package.json",
      1024,
    )

    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("distinguishes a cached empty file from a short-lived cached 404", async () => {
    let now = 100
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = String(input)
      return Promise.resolve(
        url.includes("empty.txt")
          ? fileResponse("empty.txt", "")
          : new Response(null, { status: 404 }),
      )
    })
    const client = new GitHubClient({
      fetcher,
      requestCache: {},
      missingContentTtlMs: 50,
      now: () => now,
    })

    await expect(
      client.getRepositoryTextFile(metadata, "empty.txt", 10),
    ).resolves.toBe("")
    await expect(
      client.getRepositoryTextFile(metadata, "missing.txt", 10),
    ).resolves.toBeNull()
    await expect(
      client.getRepositoryTextFile(metadata, "missing.txt", 10),
    ).resolves.toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)

    now = 151
    await client.getRepositoryTextFile(metadata, "missing.txt", 10)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it("expires mutable ref data while retaining immutable commit content", async () => {
    let now = 100
    const fetcher = createFixtureFetcher()
    const client = new GitHubClient({
      fetcher,
      requestCache: {},
      mutableResponseTtlMs: 50,
      now: () => now,
    })

    await client.getRepositoryMetadata(repository)
    await client.getRepositoryMetadata(repository)
    await client.getRepositoryTextFile(metadata, "package.json", 1024)
    expect(fetcher).toHaveBeenCalledTimes(3)

    now = 151
    await client.getRepositoryMetadata(repository)
    await client.getRepositoryTextFile(metadata, "package.json", 1024)
    expect(fetcher).toHaveBeenCalledTimes(5)
  })

  it.each([
    [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000" }],
    [429, { "retry-after": "Thu, 01 Jan 1970 00:33:20 GMT" }],
  ])(
    "stops network retries after a rate-limited %s response until reset",
    async (status, headers) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status, headers }))
      const client = new GitHubClient({
        fetcher,
        requestCache: {},
        now: () => 1_000_000,
      })

      const first = await client
        .getRepositoryTextFile(metadata, "missing.txt", 10)
        .catch((error: unknown) => error)
      const second = await client
        .getRepositoryTextFile(metadata, "other.txt", 10)
        .catch((error: unknown) => error)

      expect(first).toBeInstanceOf(GitHubApiError)
      expect(first).toMatchObject({
        code: "rate-limited",
        retryAt: new Date(2_000_000),
      })
      expect(second).toMatchObject({ code: "rate-limited" })
      expect(fetcher).toHaveBeenCalledTimes(1)
    },
  )

  it("applies a one-minute cooldown to a headerless secondary limit", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 429 }))
    const client = new GitHubClient({
      fetcher,
      requestCache: {},
      now: () => 1_000_000,
    })

    const error = await client
      .getRepositoryTextFile(metadata, "missing.txt", 10)
      .catch((reason: unknown) => reason)
    await client
      .getRepositoryTextFile(metadata, "other.txt", 10)
      .catch(() => undefined)

    expect(error).toMatchObject({
      code: "rate-limited",
      retryAt: new Date(1_060_000),
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("honors an exhausted remaining header after returning the current success", async () => {
    const exhaustedResponse = fileResponse("first.txt", "ok")
    exhaustedResponse.headers.set("x-ratelimit-remaining", "0")
    exhaustedResponse.headers.set("x-ratelimit-reset", "2000")
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(exhaustedResponse)
    const client = new GitHubClient({
      fetcher,
      requestCache: {},
      now: () => 1_000_000,
    })

    await expect(
      client.getRepositoryTextFile(metadata, "first.txt", 10),
    ).resolves.toBe("ok")
    await expect(
      client.getRepositoryTextFile(metadata, "second.txt", 10),
    ).rejects.toMatchObject({
      code: "rate-limited",
      retryAt: new Date(2_000_000),
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("does not retain failed requests or responses larger than the cache cap", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(() =>
        Promise.resolve(fileResponse("large.txt", "x".repeat(200))),
      )
    const client = new GitHubClient({
      fetcher,
      requestCache: { maxBytes: 100 },
    })

    await expect(
      client.getRepositoryTextFile(metadata, "large.txt", 1024),
    ).rejects.toMatchObject({ code: "network" })
    await client.getRepositoryTextFile(metadata, "large.txt", 1024)
    await client.getRepositoryTextFile(metadata, "large.txt", 1024)

    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})

function createFixtureFetcher(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>((input) => {
    const url = new URL(String(input))

    if (url.pathname === "/repos/acme/fullstack") {
      return Promise.resolve(
        jsonResponse({
          id: 7,
          name: "fullstack",
          owner: { login: "acme" },
          default_branch: "main",
          homepage: null,
          private: false,
        }),
      )
    }
    if (url.pathname === "/repos/acme/fullstack/branches/main") {
      return Promise.resolve(jsonResponse({ commit: { sha: SHA_A } }))
    }
    if (url.pathname === "/repos/acme/fullstack/branches/feature%2Fnew-ui") {
      return Promise.resolve(jsonResponse({ commit: { sha: SHA_B } }))
    }
    if (url.pathname === "/repos/acme/fullstack/branches") {
      return Promise.resolve(
        jsonResponse([
          { name: "main", commit: { sha: SHA_A } },
          { name: "feature/new-ui", commit: { sha: SHA_B } },
        ]),
      )
    }
    if (url.pathname === "/repos/acme/fullstack/deployments") {
      return Promise.resolve(jsonResponse([]))
    }
    if (url.pathname === "/repos/acme/fullstack/contents") {
      return Promise.resolve(
        jsonResponse([
          contentEntry("file", "package.json", "package.json", 75),
          contentEntry("dir", "frontend", "frontend", 0),
          contentEntry("dir", "backend", "backend", 0),
        ]),
      )
    }
    if (url.pathname === "/repos/acme/fullstack/contents/frontend") {
      return Promise.resolve(
        jsonResponse([
          contentEntry("file", "package.json", "frontend/package.json", 80),
          contentEntry("file", "vite.config.ts", "frontend/vite.config.ts", 20),
        ]),
      )
    }

    const path = decodeURIComponent(
      url.pathname.replace("/repos/acme/fullstack/contents/", ""),
    )
    const files: Record<string, string> = {
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
    const content = files[path]

    if (content === undefined) {
      return Promise.resolve(new Response(null, { status: 404 }))
    }
    return Promise.resolve(fileResponse(path, content))
  })
}

function contentEntry(
  type: "file" | "dir",
  name: string,
  path: string,
  size: number,
) {
  return { type, name, path, size }
}

function fileResponse(path: string, content: string): Response {
  const bytes = new TextEncoder().encode(content)
  return jsonResponse({
    type: "file",
    path,
    size: bytes.byteLength,
    encoding: "base64",
    content: btoa(String.fromCharCode(...bytes)),
  })
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}
