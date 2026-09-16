import { describe, expect, it, vi } from "vitest"

import { RepositoryMetadataCache } from "../core/github/repositoryMetadataCache"
import { DEFAULT_REPOSITORY_REF } from "../core/github/repositoryRef"
import type { RepositoryMetadata } from "../types/repository"

const metadata: RepositoryMetadata = {
  repositoryId: 10270250,
  owner: "facebook",
  repo: "react",
  defaultBranch: "main",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  homepage: "https://react.dev/",
}

const branchMetadata: RepositoryMetadata = {
  ...metadata,
  commitSha: "1111111111111111111111111111111111111111",
}

function branchRef(name: string) {
  return { kind: "branch" as const, name }
}

describe("RepositoryMetadataCache", () => {
  it("reuses commit-pinned metadata while the current ref is fresh", async () => {
    const getRepositoryMetadata = vi.fn().mockResolvedValue(metadata)
    const getRepositoryMetadataAtBranch = vi.fn()
    const cache = new RepositoryMetadataCache(
      { getRepositoryMetadata, getRepositoryMetadataAtBranch },
      { currentRefTtlMs: 1_000, now: () => 100 },
    )

    await expect(
      cache.load({
        repository: { owner: "Facebook", repo: "React" },
        ref: DEFAULT_REPOSITORY_REF,
      }),
    ).resolves.toBe(metadata)
    await expect(
      cache.load({
        repository: { owner: "facebook", repo: "react" },
        ref: DEFAULT_REPOSITORY_REF,
      }),
    ).resolves.toBe(metadata)

    expect(getRepositoryMetadata).toHaveBeenCalledTimes(1)
    expect(getRepositoryMetadataAtBranch).not.toHaveBeenCalled()
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
      {
        getRepositoryMetadata,
        getRepositoryMetadataAtBranch: vi.fn(),
      },
      { currentRefTtlMs: 1_000, now: () => now },
    )
    const target = {
      repository: { owner: "facebook", repo: "react" },
      ref: DEFAULT_REPOSITORY_REF,
    }

    await cache.load(target)
    now = 1_101

    await expect(cache.load(target)).resolves.toBe(updated)
    expect(getRepositoryMetadata).toHaveBeenCalledTimes(2)
  })

  it("does not cache failed requests", async () => {
    const getRepositoryMetadata = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(metadata)
    const cache = new RepositoryMetadataCache({
      getRepositoryMetadata,
      getRepositoryMetadataAtBranch: vi.fn(),
    })
    const target = {
      repository: { owner: "facebook", repo: "react" },
      ref: DEFAULT_REPOSITORY_REF,
    }

    await expect(cache.load(target)).rejects.toThrow("offline")
    await expect(cache.load(target)).resolves.toBe(metadata)

    expect(getRepositoryMetadata).toHaveBeenCalledTimes(2)
  })

  it("keeps the default branch and a selected branch's current-ref caches isolated", async () => {
    const getRepositoryMetadata = vi.fn().mockResolvedValue(metadata)
    const getRepositoryMetadataAtBranch = vi
      .fn()
      .mockResolvedValue(branchMetadata)
    const cache = new RepositoryMetadataCache(
      { getRepositoryMetadata, getRepositoryMetadataAtBranch },
      { currentRefTtlMs: 1_000, now: () => 100 },
    )
    const repository = { owner: "facebook", repo: "react" }

    const main = await cache.load({ repository, ref: DEFAULT_REPOSITORY_REF })
    const feature = await cache.load({
      repository,
      ref: branchRef("feature/foo"),
    })
    const mainAgain = await cache.load({
      repository,
      ref: DEFAULT_REPOSITORY_REF,
    })
    const featureAgain = await cache.load({
      repository,
      ref: branchRef("feature/foo"),
    })

    expect(main).toBe(metadata)
    expect(feature).toBe(branchMetadata)
    expect(mainAgain).toBe(metadata)
    expect(featureAgain).toBe(branchMetadata)
    expect(getRepositoryMetadata).toHaveBeenCalledTimes(1)
    expect(getRepositoryMetadataAtBranch).toHaveBeenCalledTimes(1)
    expect(getRepositoryMetadataAtBranch).toHaveBeenCalledWith(
      repository,
      "feature/foo",
      undefined,
    )
  })

  it("caches two different branches independently even when both resolve to the same commit", async () => {
    const getRepositoryMetadataAtBranch = vi
      .fn()
      .mockResolvedValueOnce(branchMetadata)
      .mockResolvedValueOnce({ ...branchMetadata })
    const cache = new RepositoryMetadataCache(
      {
        getRepositoryMetadata: vi.fn(),
        getRepositoryMetadataAtBranch,
      },
      { currentRefTtlMs: 1_000, now: () => 100 },
    )
    const repository = { owner: "facebook", repo: "react" }

    const a = await cache.load({ repository, ref: branchRef("feature/a") })
    const b = await cache.load({ repository, ref: branchRef("feature/b") })

    expect(a.commitSha).toBe(b.commitSha)
    expect(getRepositoryMetadataAtBranch).toHaveBeenCalledTimes(2)
    expect(getRepositoryMetadataAtBranch).toHaveBeenNthCalledWith(
      1,
      repository,
      "feature/a",
      undefined,
    )
    expect(getRepositoryMetadataAtBranch).toHaveBeenNthCalledWith(
      2,
      repository,
      "feature/b",
      undefined,
    )
  })

  it("reuses the same branch's TTL cache within its window", async () => {
    const getRepositoryMetadataAtBranch = vi
      .fn()
      .mockResolvedValue(branchMetadata)
    const cache = new RepositoryMetadataCache(
      {
        getRepositoryMetadata: vi.fn(),
        getRepositoryMetadataAtBranch,
      },
      { currentRefTtlMs: 1_000, now: () => 500 },
    )
    const target = {
      repository: { owner: "facebook", repo: "react" },
      ref: branchRef("feature/foo"),
    }

    await cache.load(target)
    await cache.load(target)

    expect(getRepositoryMetadataAtBranch).toHaveBeenCalledTimes(1)
  })

  it("resolves an updated branch HEAD once the branch ref TTL expires", async () => {
    let now = 100
    const updatedBranchMetadata = {
      ...branchMetadata,
      commitSha: "2222222222222222222222222222222222222222",
    }
    const getRepositoryMetadataAtBranch = vi
      .fn()
      .mockResolvedValueOnce(branchMetadata)
      .mockResolvedValueOnce(updatedBranchMetadata)
    const cache = new RepositoryMetadataCache(
      {
        getRepositoryMetadata: vi.fn(),
        getRepositoryMetadataAtBranch,
      },
      { currentRefTtlMs: 1_000, now: () => now },
    )
    const target = {
      repository: { owner: "facebook", repo: "react" },
      ref: branchRef("feature/foo"),
    }

    await cache.load(target)
    now = 1_101

    await expect(cache.load(target)).resolves.toBe(updatedBranchMetadata)
    expect(getRepositoryMetadataAtBranch).toHaveBeenCalledTimes(2)
  })
})
