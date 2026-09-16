import { describe, expect, it, vi } from "vitest"

import { RepositoryAnalysisService } from "../core/analyzer/repositoryAnalysisService"
import type { RepositoryFileSnapshot } from "../core/github/knownFiles"
import { DEFAULT_REPOSITORY_REF } from "../core/github/repositoryRef"
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

const repository = { owner: "acme", repo: "web" }
const target = { repository, ref: DEFAULT_REPOSITORY_REF }
const branchTarget = {
  repository,
  ref: { kind: "branch" as const, name: "feature/login" },
}

describe("RepositoryAnalysisService", () => {
  it("reuses analysis for the same repository commit", async () => {
    const loadMetadata = vi.fn().mockResolvedValue(metadata)
    const loadFiles = vi.fn().mockResolvedValue(files)
    const service = new RepositoryAnalysisService(loadMetadata, {
      load: loadFiles,
    })

    const first = await service.load(target)
    const second = await service.load(target)

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

    const first = await service.load(target)
    const second = await service.load(target)

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

    await expect(service.load(target)).rejects.toThrow("offline")
    await expect(service.load(target)).resolves.toMatchObject({
      repository: metadata,
    })
    expect(loadFiles).toHaveBeenCalledTimes(2)
  })

  it("shares the commit-pinned analysis cache across a branch and the default ref at the same SHA", async () => {
    const loadMetadata = vi.fn().mockResolvedValue(metadata)
    const loadFiles = vi.fn().mockResolvedValue(files)
    const service = new RepositoryAnalysisService(loadMetadata, {
      load: loadFiles,
    })

    const fromDefault = await service.load(target)
    const fromBranch = await service.load(branchTarget)

    expect(fromBranch).toBe(fromDefault)
    expect(loadFiles).toHaveBeenCalledTimes(1)
  })

  it("passes the selected branch ref, not a bare string, to metadata resolution", async () => {
    const loadMetadata = vi.fn().mockResolvedValue(metadata)
    const loadFiles = vi.fn().mockResolvedValue(files)
    const service = new RepositoryAnalysisService(loadMetadata, {
      load: loadFiles,
    })

    await service.load(branchTarget)

    expect(loadMetadata).toHaveBeenCalledWith(branchTarget, expect.anything())
  })

  it("reads known files using the resolved commit SHA regardless of the selected ref", async () => {
    const loadMetadata = vi.fn().mockResolvedValue(metadata)
    const loadFiles = vi.fn().mockResolvedValue(files)
    const service = new RepositoryAnalysisService(loadMetadata, {
      load: loadFiles,
    })

    await service.load(branchTarget)

    expect(loadFiles).toHaveBeenCalledWith(metadata, undefined)
  })
})
