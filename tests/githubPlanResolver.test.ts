import { describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "../core/github/client"
import type { KnownRepositoryFilesLoader } from "../core/github/knownFiles"
import { GitHubPreviewPlanResolver } from "../services/preview-api/githubPlanResolver"
import type { PreviewRepositoryRef } from "../types/preview"

const repository: PreviewRepositoryRef = {
  repositoryId: 1,
  owner: "acme",
  name: "web",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
}

const metadata = {
  repositoryId: 1,
  owner: "acme",
  repo: "web",
  defaultBranch: "main",
  commitSha: repository.commitSha,
  homepage: null,
}

describe("GitHubPreviewPlanResolver", () => {
  it("derives the implemented Vite React npm plan at the pinned commit", async () => {
    const github = {
      getRepositoryMetadataAtCommit: vi.fn().mockResolvedValue(metadata),
    } as unknown as GitHubClient
    const knownFiles = {
      load: vi.fn().mockResolvedValue(viteReactFiles()),
    } as unknown as KnownRepositoryFilesLoader
    const resolver = new GitHubPreviewPlanResolver(github, knownFiles)

    await expect(
      resolver.resolve(repository, "static-v1"),
    ).resolves.toMatchObject({
      repository,
      packageManager: "npm",
      installCommand: "npm ci",
      buildCommand: "npm run build",
      outputDirectory: "dist",
    })
    expect(github.getRepositoryMetadataAtCommit).toHaveBeenCalledWith(
      repository,
    )
  })

  it("derives the package-free static plan at the pinned commit", async () => {
    const github = {
      getRepositoryMetadataAtCommit: vi.fn().mockResolvedValue(metadata),
    } as unknown as GitHubClient
    const knownFiles = {
      load: vi.fn().mockResolvedValue({
        presentPaths: ["index.html"],
        textFiles: {},
        warnings: [],
        complete: true,
      }),
    } as unknown as KnownRepositoryFilesLoader
    const resolver = new GitHubPreviewPlanResolver(github, knownFiles)

    await expect(resolver.resolve(repository, "static-v1")).resolves.toEqual({
      contractVersion: "static-v1",
      repository,
      sourceRoot: ".",
      packageManager: "none",
      installCommand: null,
      buildCommand: null,
      outputDirectory: ".",
    })
    expect(knownFiles.load).toHaveBeenCalledWith(metadata)
  })

  it("rejects contracts and runner targets not implemented in v0.1", async () => {
    const github = {
      getRepositoryMetadataAtCommit: vi.fn().mockResolvedValue(metadata),
    } as unknown as GitHubClient
    const knownFiles = {
      load: vi.fn().mockResolvedValue({
        ...viteReactFiles(),
        textFiles: {
          ...viteReactFiles().textFiles,
          "package.json": JSON.stringify({
            scripts: { build: "vite build" },
            dependencies: { vue: "latest", vite: "latest" },
          }),
        },
      }),
    } as unknown as KnownRepositoryFilesLoader
    const resolver = new GitHubPreviewPlanResolver(github, knownFiles)

    await expect(resolver.resolve(repository, "future-v2")).resolves.toBeNull()
    await expect(resolver.resolve(repository, "static-v1")).resolves.toBeNull()
  })

  it("rejects recognized package managers without a registered adapter", async () => {
    const github = {
      getRepositoryMetadataAtCommit: vi.fn().mockResolvedValue(metadata),
    } as unknown as GitHubClient
    const files = viteReactFiles()
    const knownFiles = {
      load: vi.fn().mockResolvedValue({
        ...files,
        presentPaths: files.presentPaths
          .filter((path) => path !== "package-lock.json")
          .concat("pnpm-lock.yaml"),
      }),
    } as unknown as KnownRepositoryFilesLoader
    const resolver = new GitHubPreviewPlanResolver(github, knownFiles)

    await expect(resolver.resolve(repository, "static-v1")).resolves.toBeNull()
  })

  it("does not promote nested full-stack candidates into a root build", async () => {
    const github = {
      getRepositoryMetadataAtCommit: vi.fn().mockResolvedValue(metadata),
    } as unknown as GitHubClient
    const knownFiles = {
      load: vi.fn().mockResolvedValue({
        presentPaths: ["package.json", "package-lock.json"],
        textFiles: {
          "package.json": JSON.stringify({
            workspaces: ["frontend", "backend"],
          }),
        },
        warnings: [],
        complete: true,
      }),
    } as unknown as KnownRepositoryFilesLoader
    const resolver = new GitHubPreviewPlanResolver(github, knownFiles)

    await expect(resolver.resolve(repository, "static-v1")).resolves.toBeNull()
  })
})

function viteReactFiles() {
  return {
    presentPaths: [
      "index.html",
      "package-lock.json",
      "package.json",
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
  }
}
