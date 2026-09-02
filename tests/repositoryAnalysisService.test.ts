import { describe, expect, it, vi } from "vitest"

import { RepositoryAnalysisService } from "../core/analyzer/repositoryAnalysisService"
import type { RepositoryFileSnapshot } from "../core/github/knownFiles"
import type { RepositoryMetadata } from "../types/repository"

const metadata: RepositoryMetadata = {
  repositoryId: 1,
  owner: "acme",
  repo: "web",
  defaultBranch: "main",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  homepage: null,
}

const files: RepositoryFileSnapshot = {
  presentPaths: ["index.html"],
  textFiles: {},
  warnings: [],
  complete: true,
}

describe("RepositoryAnalysisService", () => {
  it("reuses analysis for the same repository commit", async () => {
    const loadMetadata = vi.fn().mockResolvedValue(metadata)
    const loadFiles = vi.fn().mockResolvedValue(files)
    const service = new RepositoryAnalysisService(loadMetadata, {
      load: loadFiles,
    })

    const first = await service.load({ owner: "acme", repo: "web" })
    const second = await service.load({ owner: "acme", repo: "web" })

    expect(second).toBe(first)
    expect(loadMetadata).toHaveBeenCalledTimes(2)
    expect(loadFiles).toHaveBeenCalledTimes(1)
  })

  it("reanalyzes when the resolved commit changes", async () => {
    const nextMetadata = {
      ...metadata,
      commitSha: "abcdef0123456789abcdef0123456789abcdef01",
    }
    const loadMetadata = vi
      .fn()
      .mockResolvedValueOnce(metadata)
      .mockResolvedValueOnce(nextMetadata)
    const loadFiles = vi.fn().mockResolvedValue(files)
    const service = new RepositoryAnalysisService(loadMetadata, {
      load: loadFiles,
    })

    const first = await service.load({ owner: "acme", repo: "web" })
    const second = await service.load({ owner: "acme", repo: "web" })

    expect(first.repository.commitSha).not.toBe(second.repository.commitSha)
    expect(loadFiles).toHaveBeenCalledTimes(2)
  })

  it("does not cache failed file loading", async () => {
    const loadMetadata = vi.fn().mockResolvedValue(metadata)
    const loadFiles = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(files)
    const service = new RepositoryAnalysisService(loadMetadata, {
      load: loadFiles,
    })

    await expect(service.load({ owner: "acme", repo: "web" })).rejects.toThrow(
      "offline",
    )
    await expect(
      service.load({ owner: "acme", repo: "web" }),
    ).resolves.toMatchObject({ repository: metadata })
    expect(loadFiles).toHaveBeenCalledTimes(2)
  })
})
