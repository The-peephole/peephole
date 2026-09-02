import { describe, expect, it, vi } from "vitest"

import { GitHubApiError, GitHubClient } from "../core/github/client"
import type { RepositoryMetadata } from "../types/repository"

const repositoryResponse = {
  id: 10270250,
  name: "react",
  owner: { login: "facebook" },
  default_branch: "main",
  homepage: "https://react.dev",
  private: false,
}

const branchResponse = {
  commit: { sha: "0123456789abcdef0123456789abcdef01234567" },
}

const metadata: RepositoryMetadata = {
  repositoryId: 10270250,
  owner: "facebook",
  repo: "react",
  defaultBranch: "main",
  commitSha: branchResponse.commit.sha,
  homepage: "https://react.dev/",
}

describe("GitHubClient", () => {
  it("does not call browser fetch with the GitHubClient as its receiver", async () => {
    const responses = [
      jsonResponse(repositoryResponse),
      jsonResponse(branchResponse),
    ]
    const fetcher = vi.fn(function (this: unknown): Promise<Response> {
      if (this instanceof GitHubClient) {
        throw new TypeError("Illegal invocation")
      }

      const response = responses.shift()

      if (!response) {
        throw new Error("Unexpected request")
      }

      return Promise.resolve(response)
    }) as unknown as typeof fetch
    const client = new GitHubClient({ fetcher })

    await expect(
      client.getRepositoryMetadata({ owner: "react", repo: "react" }),
    ).resolves.toMatchObject({ repositoryId: 10270250 })
  })

  it("loads public repository metadata and its default-branch commit", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(repositoryResponse))
      .mockResolvedValueOnce(jsonResponse(branchResponse))
    const client = new GitHubClient({ fetcher })

    await expect(
      client.getRepositoryMetadata({ owner: "facebook", repo: "react" }),
    ).resolves.toEqual({
      repositoryId: 10270250,
      owner: "facebook",
      repo: "react",
      defaultBranch: "main",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      homepage: "https://react.dev/",
    })

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/repos/facebook/react",
      expect.objectContaining({
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
        },
      }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/facebook/react/branches/main",
      expect.any(Object),
    )
  })

  it("revalidates repository identity and an exact requested commit", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(repositoryResponse))
      .mockResolvedValueOnce(jsonResponse({ sha: branchResponse.commit.sha }))
    const client = new GitHubClient({ fetcher })

    await expect(
      client.getRepositoryMetadataAtCommit({
        repositoryId: repositoryResponse.id,
        owner: "facebook",
        name: "react",
        commitSha: branchResponse.commit.sha,
      }),
    ).resolves.toEqual(metadata)

    expect(fetcher.mock.calls[1]?.[0]).toBe(
      `https://api.github.com/repos/facebook/react/commits/${branchResponse.commit.sha}`,
    )
  })

  it("rejects a mismatched repository id before resolving a commit", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(repositoryResponse))
    const client = new GitHubClient({ fetcher })

    await expect(
      client.getRepositoryMetadataAtCommit({
        repositoryId: 999,
        owner: "facebook",
        name: "react",
        commitSha: branchResponse.commit.sha,
      }),
    ).rejects.toMatchObject({ code: "not-found" })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("encodes repository and branch path segments", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          ...repositoryResponse,
          name: "repo.name",
          owner: { login: "owner-name" },
          default_branch: "release/v1",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(branchResponse))
    const client = new GitHubClient({ fetcher })

    await client.getRepositoryMetadata({
      owner: "owner-name",
      repo: "repo.name",
    })

    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/repos/owner-name/repo.name/branches/release%2Fv1",
    )
  })

  it("returns a rate-limit error with the reset time", async () => {
    const reset = 2_000_000_000
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(reset),
        },
      }),
    )
    const client = new GitHubClient({ fetcher })

    const error = await client
      .getRepositoryMetadata({ owner: "facebook", repo: "react" })
      .catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(GitHubApiError)
    expect(error).toMatchObject({
      code: "rate-limited",
      status: 403,
      retryAt: new Date(reset * 1000),
    })
  })

  it("rejects unexpected response shapes before using them", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ id: "not-a-number" }))
    const client = new GitHubClient({ fetcher })

    await expect(
      client.getRepositoryMetadata({ owner: "facebook", repo: "react" }),
    ).rejects.toMatchObject({ code: "invalid-response" })

    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("drops unsafe homepage protocols", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          ...repositoryResponse,
          homepage: "javascript:alert(1)",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(branchResponse))
    const client = new GitHubClient({ fetcher })

    const metadata = await client.getRepositoryMetadata({
      owner: "facebook",
      repo: "react",
    })

    expect(metadata.homepage).toBeNull()
  })

  it("lists root entries at the resolved commit SHA", async () => {
    const entries = [
      { type: "file", name: "package.json", path: "package.json", size: 42 },
      { type: "dir", name: "src", path: "src", size: 0 },
    ]
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(entries))
    const client = new GitHubClient({ fetcher })

    await expect(client.getRepositoryRootEntries(metadata)).resolves.toEqual(
      entries,
    )
    expect(fetcher).toHaveBeenCalledWith(
      `https://api.github.com/repos/facebook/react/contents?ref=${metadata.commitSha}`,
      expect.any(Object),
    )
  })

  it("decodes a commit-pinned UTF-8 text file", async () => {
    const content = '{"name":"café"}'
    const encoded = bytesToBase64(new TextEncoder().encode(content))
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        type: "file",
        path: "package.json",
        size: new TextEncoder().encode(content).byteLength,
        encoding: "base64",
        content: encoded,
      }),
    )
    const client = new GitHubClient({ fetcher })

    await expect(
      client.getRepositoryTextFile(metadata, "package.json", 1_024),
    ).resolves.toBe(content)
    expect(fetcher).toHaveBeenCalledWith(
      `https://api.github.com/repos/facebook/react/contents/package.json?ref=${metadata.commitSha}`,
      expect.any(Object),
    )
  })

  it("treats a missing optional file as absent", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 404 }))
    const client = new GitHubClient({ fetcher })

    await expect(
      client.getRepositoryTextFile(metadata, ".env.example", 1_024),
    ).resolves.toBeNull()
  })

  it("rejects file metadata that exceeds the configured byte limit", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        type: "file",
        path: "package.json",
        size: 2_048,
        encoding: "base64",
        content: "e30=",
      }),
    )
    const client = new GitHubClient({ fetcher })

    await expect(
      client.getRepositoryTextFile(metadata, "package.json", 1_024),
    ).rejects.toMatchObject({ code: "invalid-response" })
  })
})

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}
