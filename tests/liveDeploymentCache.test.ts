import { describe, expect, it, vi } from "vitest"

import { RepositoryLiveDeploymentCache } from "../core/github/liveDeploymentCache"
import type { RepositoryLiveDeployment } from "../types/deployment"

const notDetected: RepositoryLiveDeployment = {
  status: "not-detected",
  candidate: null,
  candidateCount: 0,
  truncated: false,
  evidence: [],
}

describe("RepositoryLiveDeploymentCache", () => {
  it("reuses a cached result within the TTL", async () => {
    const load = vi.fn().mockResolvedValue(notDetected)
    const cache = new RepositoryLiveDeploymentCache(
      { load },
      { ttlMs: 1_000, now: () => 100 },
    )

    await cache.load({ owner: "acme", repo: "web" })
    await cache.load({ owner: "acme", repo: "web" })

    expect(load).toHaveBeenCalledTimes(1)
  })

  it("is case-insensitive on repository identity", async () => {
    const load = vi.fn().mockResolvedValue(notDetected)
    const cache = new RepositoryLiveDeploymentCache(
      { load },
      { ttlMs: 1_000, now: () => 100 },
    )

    await cache.load({ owner: "Acme", repo: "Web" })
    await cache.load({ owner: "acme", repo: "web" })

    expect(load).toHaveBeenCalledTimes(1)
  })

  it("refetches once the TTL expires", async () => {
    let now = 0
    const load = vi.fn().mockResolvedValue(notDetected)
    const cache = new RepositoryLiveDeploymentCache(
      { load },
      { ttlMs: 1_000, now: () => now },
    )

    await cache.load({ owner: "acme", repo: "web" })
    now = 1_001
    await cache.load({ owner: "acme", repo: "web" })

    expect(load).toHaveBeenCalledTimes(2)
  })

  it("keeps two different repositories in separate cache entries", async () => {
    const load = vi.fn().mockResolvedValue(notDetected)
    const cache = new RepositoryLiveDeploymentCache(
      { load },
      { ttlMs: 1_000, now: () => 0 },
    )

    await cache.load({ owner: "acme", repo: "a" })
    await cache.load({ owner: "acme", repo: "b" })

    expect(load).toHaveBeenCalledTimes(2)
  })

  it("does not cache a failed lookup", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce(notDetected)
    const cache = new RepositoryLiveDeploymentCache(
      { load },
      { ttlMs: 1_000, now: () => 0 },
    )

    await expect(cache.load({ owner: "acme", repo: "web" })).rejects.toThrow(
      "rate limited",
    )
    await expect(cache.load({ owner: "acme", repo: "web" })).resolves.toBe(
      notDetected,
    )
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("defaults to a TTL between 30 and 60 seconds", async () => {
    const load = vi.fn().mockResolvedValue(notDetected)
    const realNow = Date.now()
    let now = realNow
    const cache = new RepositoryLiveDeploymentCache(
      { load },
      { now: () => now },
    )

    await cache.load({ owner: "acme", repo: "web" })
    now = realNow + 29_000
    await cache.load({ owner: "acme", repo: "web" })
    expect(load).toHaveBeenCalledTimes(1)

    now = realNow + 61_000
    await cache.load({ owner: "acme", repo: "web" })
    expect(load).toHaveBeenCalledTimes(2)
  })
})
