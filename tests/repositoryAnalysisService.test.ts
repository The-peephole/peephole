import { describe, expect, it, vi } from "vitest"

import { RepositoryAnalysisService } from "../core/analyzer/repositoryAnalysisService"
import { BuildTargetAnalysisService } from "../core/analyzer/buildTargetAnalysisService"
import type { RepositoryFileSnapshot } from "../core/github/knownFiles"
import { DEFAULT_REPOSITORY_REF } from "../core/github/repositoryRef"
import type { RepositoryMetadata } from "../types/repository"
import type { RepositoryStructure } from "../types/structure"

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

const structure: RepositoryStructure = {
  layout: "single-project",
  projects: [
    {
      path: ".",
      isRoot: true,
      role: "project-candidate",
      hasPackageJson: false,
      packageName: null,
      evidence: [],
      warnings: [],
    },
  ],
  workspaceEvidence: [],
  warnings: [],
  complete: true,
  truncated: false,
}

const notDetectedBackend = {
  status: "not-detected" as const,
  candidates: [],
  evidence: [],
  warnings: [],
  complete: true,
  truncated: false,
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
    const service = new RepositoryAnalysisService(
      loadMetadata,
      { load: loadFiles },
      { load: vi.fn().mockResolvedValue(structure) },
      { load: vi.fn().mockResolvedValue(notDetectedBackend) },
    )

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
    const service = new RepositoryAnalysisService(
      loadMetadata,
      { load: loadFiles },
      { load: vi.fn().mockResolvedValue(structure) },
      { load: vi.fn().mockResolvedValue(notDetectedBackend) },
    )

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
    const service = new RepositoryAnalysisService(
      loadMetadata,
      { load: loadFiles },
      { load: vi.fn().mockResolvedValue(structure) },
      { load: vi.fn().mockResolvedValue(notDetectedBackend) },
    )

    await expect(service.load(target)).rejects.toThrow("offline")
    await expect(service.load(target)).resolves.toMatchObject({
      repository: metadata,
    })
    expect(loadFiles).toHaveBeenCalledTimes(2)
  })

  it("shares the commit-pinned analysis cache across a branch and the default ref at the same SHA", async () => {
    const loadMetadata = vi.fn().mockResolvedValue(metadata)
    const loadFiles = vi.fn().mockResolvedValue(files)
    const service = new RepositoryAnalysisService(
      loadMetadata,
      { load: loadFiles },
      { load: vi.fn().mockResolvedValue(structure) },
      { load: vi.fn().mockResolvedValue(notDetectedBackend) },
    )

    const fromDefault = await service.load(target)
    const fromBranch = await service.load(branchTarget)

    expect(fromBranch).toBe(fromDefault)
    expect(loadFiles).toHaveBeenCalledTimes(1)
  })

  it("passes the selected branch ref, not a bare string, to metadata resolution", async () => {
    const loadMetadata = vi.fn().mockResolvedValue(metadata)
    const loadFiles = vi.fn().mockResolvedValue(files)
    const service = new RepositoryAnalysisService(
      loadMetadata,
      { load: loadFiles },
      { load: vi.fn().mockResolvedValue(structure) },
      { load: vi.fn().mockResolvedValue(notDetectedBackend) },
    )

    await service.load(branchTarget)

    expect(loadMetadata).toHaveBeenCalledWith(branchTarget, expect.anything())
  })

  it("reads known files using the resolved commit SHA regardless of the selected ref", async () => {
    const loadMetadata = vi.fn().mockResolvedValue(metadata)
    const loadFiles = vi.fn().mockResolvedValue(files)
    const service = new RepositoryAnalysisService(
      loadMetadata,
      { load: loadFiles },
      { load: vi.fn().mockResolvedValue(structure) },
      { load: vi.fn().mockResolvedValue(notDetectedBackend) },
    )

    await service.load(branchTarget)

    expect(loadFiles).toHaveBeenCalledWith(metadata, undefined)
  })

  it("resolves repository structure from the same resolved metadata and file snapshot", async () => {
    const loadMetadata = vi.fn().mockResolvedValue(metadata)
    const loadFiles = vi.fn().mockResolvedValue(files)
    const loadStructure = vi.fn().mockResolvedValue(structure)
    const service = new RepositoryAnalysisService(
      loadMetadata,
      { load: loadFiles },
      { load: loadStructure },
      { load: vi.fn().mockResolvedValue(notDetectedBackend) },
    )

    const analysis = await service.load(target)

    expect(loadStructure).toHaveBeenCalledWith(metadata, files, undefined)
    expect(analysis.structure).toBe(structure)
  })

  it("reuses the cached analysis without recomputing structure for the same commit", async () => {
    const loadMetadata = vi.fn().mockResolvedValue(metadata)
    const loadFiles = vi.fn().mockResolvedValue(files)
    const loadStructure = vi.fn().mockResolvedValue(structure)
    const service = new RepositoryAnalysisService(
      loadMetadata,
      { load: loadFiles },
      { load: loadStructure },
      { load: vi.fn().mockResolvedValue(notDetectedBackend) },
    )

    await service.load(target)
    await service.load(target)

    expect(loadStructure).toHaveBeenCalledTimes(1)
  })

  it("probes nested backend candidates from the structure result, excluding the root", async () => {
    const nestedStructure: RepositoryStructure = {
      ...structure,
      layout: "multi-project",
      projects: [
        ...structure.projects,
        {
          path: "backend",
          isRoot: false,
          role: "unknown",
          hasPackageJson: true,
          packageName: "backend",
          evidence: [],
          warnings: [],
        },
      ],
    }
    const loadMetadata = vi.fn().mockResolvedValue(metadata)
    const loadFiles = vi.fn().mockResolvedValue(files)
    const loadBackend = vi.fn().mockResolvedValue(notDetectedBackend)
    const service = new RepositoryAnalysisService(
      loadMetadata,
      { load: loadFiles },
      { load: vi.fn().mockResolvedValue(nestedStructure) },
      { load: loadBackend },
    )

    await service.load(target)

    expect(loadBackend).toHaveBeenCalledWith(metadata, ["backend"], undefined)
  })

  it("does not fail repository analysis when nested backend discovery throws", async () => {
    const loadMetadata = vi.fn().mockResolvedValue(metadata)
    const loadFiles = vi.fn().mockResolvedValue(files)
    const loadBackend = vi.fn().mockRejectedValue(new Error("rate limited"))
    const service = new RepositoryAnalysisService(
      loadMetadata,
      { load: loadFiles },
      { load: vi.fn().mockResolvedValue(structure) },
      { load: loadBackend },
    )

    const analysis = await service.load(target)

    expect(analysis.backend.complete).toBe(false)
    expect(analysis.preview.mode).not.toBe("unsupported")
  })

  it("propagates an abort from nested backend discovery instead of masking it", async () => {
    const abortError = new DOMException("aborted", "AbortError")
    const loadMetadata = vi.fn().mockResolvedValue(metadata)
    const loadFiles = vi.fn().mockResolvedValue(files)
    const service = new RepositoryAnalysisService(
      loadMetadata,
      { load: loadFiles },
      { load: vi.fn().mockResolvedValue(structure) },
      { load: vi.fn().mockRejectedValue(abortError) },
    )

    await expect(service.load(target)).rejects.toBe(abortError)
  })

  it("caches by repositoryId:commitSha:analyzerVersion, not by branch name, for backend/environment data too", async () => {
    const loadMetadata = vi.fn().mockResolvedValue(metadata)
    const loadFiles = vi.fn().mockResolvedValue(files)
    const loadBackend = vi.fn().mockResolvedValue(notDetectedBackend)
    const service = new RepositoryAnalysisService(
      loadMetadata,
      { load: loadFiles },
      { load: vi.fn().mockResolvedValue(structure) },
      { load: loadBackend },
    )

    await service.load(target)
    await service.load(branchTarget)

    expect(loadBackend).toHaveBeenCalledTimes(1)
  })
})

describe("BuildTargetAnalysisService", () => {
  it("keys target analysis by repository id, exact SHA, source root, and analyzer version", async () => {
    const loadFiles = vi.fn().mockResolvedValue({
      presentPaths: [
        "index.html",
        "package.json",
        "package-lock.json",
        "vite.config.ts",
      ],
      textFiles: {
        "package.json": JSON.stringify({
          scripts: { build: "vite build" },
          dependencies: { react: "latest", vite: "latest" },
        }),
        "vite.config.ts": "export default {}",
      },
      warnings: [],
      complete: true,
    })
    const service = new BuildTargetAnalysisService({ load: loadFiles })

    const first = await service.load(metadata, { sourceRoot: "apps/web" })
    const cached = await service.load(metadata, { sourceRoot: "apps/web" })
    const other = await service.load(metadata, { sourceRoot: "apps/admin" })

    expect(cached).toBe(first)
    expect(other.target.sourceRoot).toBe("apps/admin")
    expect(loadFiles).toHaveBeenCalledTimes(2)
  })
})
