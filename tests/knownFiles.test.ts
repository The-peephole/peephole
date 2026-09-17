import { describe, expect, it, vi } from "vitest"

import type { GitHubClient, GitHubContentEntry } from "../core/github/client"
import { KnownRepositoryFilesLoader } from "../core/github/knownFiles"
import type { RepositoryMetadata } from "../types/repository"

const repository: RepositoryMetadata = {
  repositoryId: 1,
  owner: "example",
  repo: "app",
  defaultBranch: "main",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  homepage: null,
}

describe("KnownRepositoryFilesLoader", () => {
  it("fetches text only for present allowlisted files", async () => {
    const entries: GitHubContentEntry[] = [
      entry("package.json", 120),
      entry("package-lock.json", 500_000),
      entry("vite.config.ts", 80),
      entry("src", 0, "dir"),
      entry("unknown.txt", 10),
    ]
    const getRepositoryTextFile = vi.fn(
      async (_repository, path: string) => `content:${path}`,
    )
    const githubClient = {
      getRepositoryRootEntries: vi.fn().mockResolvedValue(entries),
      getRepositoryTextFile,
    } as unknown as GitHubClient
    const loader = new KnownRepositoryFilesLoader(githubClient)

    const result = await loader.load(repository)

    expect(result.presentPaths).toEqual([
      "package-lock.json",
      "package.json",
      "vite.config.ts",
    ])
    expect(result.textFiles).toEqual({
      "package.json": "content:package.json",
      "vite.config.ts": "content:vite.config.ts",
    })
    expect(getRepositoryTextFile).not.toHaveBeenCalledWith(
      expect.anything(),
      "package-lock.json",
      expect.anything(),
      expect.anything(),
    )
    expect(getRepositoryTextFile).not.toHaveBeenCalledWith(
      expect.anything(),
      "unknown.txt",
      expect.anything(),
      expect.anything(),
    )
  })

  it("records root directory names alongside known files", async () => {
    const entries: GitHubContentEntry[] = [
      entry("package.json", 120),
      entry("apps", 0, "dir"),
      entry("packages", 0, "dir"),
      entry(".github", 0, "dir"),
    ]
    const githubClient = {
      getRepositoryRootEntries: vi.fn().mockResolvedValue(entries),
      getRepositoryTextFile: vi.fn(async () => "{}"),
    } as unknown as GitHubClient
    const loader = new KnownRepositoryFilesLoader(githubClient)

    const result = await loader.load(repository)

    expect(result.rootDirectories).toEqual([".github", "apps", "packages"])
  })

  it("reads pnpm-workspace.yaml content within its byte limit", async () => {
    const content = 'packages:\n  - "apps/*"\n'
    const githubClient = {
      getRepositoryRootEntries: vi
        .fn()
        .mockResolvedValue([entry("pnpm-workspace.yaml", content.length)]),
      getRepositoryTextFile: vi.fn(async () => content),
    } as unknown as GitHubClient
    const loader = new KnownRepositoryFilesLoader(githubClient)

    const result = await loader.load(repository)

    expect(result.textFiles["pnpm-workspace.yaml"]).toBe(content)
  })

  it("skips oversized text files and records a warning", async () => {
    const githubClient = {
      getRepositoryRootEntries: vi
        .fn()
        .mockResolvedValue([entry(".env.example", 70 * 1024)]),
      getRepositoryTextFile: vi.fn(),
    } as unknown as GitHubClient
    const loader = new KnownRepositoryFilesLoader(githubClient)

    const result = await loader.load(repository)

    expect(result.textFiles).toEqual({})
    expect(result.warnings[0]).toContain(".env.example exceeds")
    expect(githubClient.getRepositoryTextFile).not.toHaveBeenCalled()
  })
})

function entry(
  path: string,
  size: number,
  type: GitHubContentEntry["type"] = "file",
): GitHubContentEntry {
  return { name: path, path, size, type }
}
