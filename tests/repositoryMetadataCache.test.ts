import { describe, expect, it, vi } from "vitest"

import { RepositoryMetadataCache } from "../core/github/repositoryMetadataCache"
import type { RepositoryMetadata } from "../types/repository"

const metadata: RepositoryMetadata = {
  repositoryId: 10270250,
  owner: "facebook",
  repo: "react",
  defaultBranch: "main",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  homepage: "https://react.dev/",
}

describe("RepositoryMetadataCache", () => {
  it("reuses commit-pinned metadata while the current ref is fresh", async () => {
    const getRepositoryMetadata = vi.fn().mockResolvedValue(metadata)
    const cache = new RepositoryMetadataCache(
      { getRepositoryMetadata },
      { currentRefTtlMs: 1_000, now: () => 100 },
    )

    await expect(
      cache.load({ owner: "Facebook", repo: "React" }),
    ).resolves.toBe(metadata)
    await expect(
      cache.load({ owner: "facebook", repo: "react" }),
    ).resolves.toBe(metadata)

    expect(getRepositoryMetadata).toHaveBeenCalledTimes(1)
  })

  it("refreshes the moving ref after its TTL", async () => {
    let now = 100
    const updated = {
      ...metadata,
      commitSha: "abcdef0123456789abcdef0123456789abcdef01",
    }
    const getRepositoryMetadata = vi
      .fn()
      .mockResolvedValueOnce(metadata)
      .mockResolvedValueOnce(updated)
    const cache = new RepositoryMetadataCache(
      { getRepositoryMetadata },
      { currentRefTtlMs: 1_000, now: () => now },
    )

    await cache.load({ owner: "facebook", repo: "react" })
    now = 1_101

    await expect(
      cache.load({ owner: "facebook", repo: "react" }),
    ).resolves.toBe(updated)
    expect(getRepositoryMetadata).toHaveBeenCalledTimes(2)
  })

  it("does not cache failed requests", async () => {
    const getRepositoryMetadata = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(metadata)
    const cache = new RepositoryMetadataCache({ getRepositoryMetadata })

    await expect(
      cache.load({ owner: "facebook", repo: "react" }),
    ).rejects.toThrow("offline")
    await expect(
      cache.load({ owner: "facebook", repo: "react" }),
    ).resolves.toBe(metadata)

    expect(getRepositoryMetadata).toHaveBeenCalledTimes(2)
  })
})
