import { describe, expect, it, vi } from "vitest"

import { GitHubApiError, type GitHubContentEntry } from "../core/github/client"
import type { RepositoryFileSnapshot } from "../core/github/knownFiles"
import { RepositoryStructureLoader } from "../core/github/repositoryStructureLoader"
import {
  MAX_STRUCTURE_CANDIDATE_PROBES,
  MAX_STRUCTURE_DIRECTORY_ENTRIES,
  MAX_STRUCTURE_DIRECTORY_LISTINGS,
} from "../core/analyzer/repositoryStructureDetector"
import type { RepositoryMetadata } from "../types/repository"

const repository: RepositoryMetadata = {
  repositoryId: 1,
  owner: "acme",
  repo: "web",
  defaultBranch: "main",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  homepage: null,
}

function snapshot(
  textFiles: Record<string, string>,
  presentPaths: string[] = [],
  rootDirectories: string[] = [],
): RepositoryFileSnapshot {
  return {
    presentPaths: Array.from(
      new Set([...Object.keys(textFiles), ...presentPaths]),
    ),
    textFiles,
    warnings: [],
    complete: true,
    rootDirectories,
  }
}

function dirEntry(
  path: string,
  type: GitHubContentEntry["type"] = "dir",
): GitHubContentEntry {
  const name = path.split("/").at(-1) ?? path
  return { type, name, path, size: 0 }
}

function packageJson(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

function createFakeClient(
  overrides: {
    directories?: Record<string, GitHubContentEntry[]>
    files?: Record<string, string | null>
    fileErrors?: Record<string, unknown>
  } = {},
) {
  const getRepositoryDirectoryEntries = vi.fn(
    async (_repository: RepositoryMetadata, path: string) => {
      const entries = overrides.directories?.[path]
      if (!entries)
        throw new GitHubApiError("not-found", `${path} not found`, 404)
      return entries
    },
  )
  const getRepositoryTextFile = vi.fn(
    async (_repository: RepositoryMetadata, path: string) => {
      if (overrides.fileErrors?.[path]) throw overrides.fileErrors[path]
      return overrides.files?.[path] ?? null
    },
  )

  return { getRepositoryDirectoryEntries, getRepositoryTextFile }
}

describe("RepositoryStructureLoader", () => {
  it("resolves package.json workspaces (array form) by listing the wildcard parent", async () => {
    const files = snapshot(
      { "package.json": packageJson({ workspaces: ["apps/*"] }) },
      ["package.json"],
      ["apps"],
    )
    const client = createFakeClient({
      directories: { apps: [dirEntry("apps/web"), dirEntry("apps/admin")] },
      files: {
        "apps/web/package.json": packageJson({ dependencies: { vite: "x" } }),
        "apps/admin/package.json": packageJson({ dependencies: { vite: "x" } }),
      },
    })
    const loader = new RepositoryStructureLoader(client)

    const structure = await loader.load(repository, files)

    expect(structure.layout).toBe("workspace")
    expect(structure.projects.map((p) => p.path).sort()).toEqual([
      ".",
      "apps/admin",
      "apps/web",
    ])
    expect(client.getRepositoryDirectoryEntries).toHaveBeenCalledWith(
      repository,
      "apps",
      undefined,
    )
  })

  it("resolves package.json workspaces (object form)", async () => {
    const files = snapshot(
      { "package.json": packageJson({ workspaces: { packages: ["apps/*"] } }) },
      ["package.json"],
      ["apps"],
    )
    const client = createFakeClient({
      directories: { apps: [dirEntry("apps/web")] },
      files: {
        "apps/web/package.json": packageJson({ dependencies: { vite: "x" } }),
      },
    })
    const loader = new RepositoryStructureLoader(client)

    const structure = await loader.load(repository, files)

    expect(structure.projects.map((p) => p.path)).toEqual([".", "apps/web"])
  })

  it("resolves multiple workspace patterns", async () => {
    const files = snapshot(
      {
        "package.json": packageJson({ workspaces: ["apps/*", "packages/*"] }),
      },
      ["package.json"],
      ["apps", "packages"],
    )
    const client = createFakeClient({
      directories: {
        apps: [dirEntry("apps/web")],
        packages: [dirEntry("packages/ui")],
      },
      files: {
        "apps/web/package.json": packageJson({ dependencies: { vite: "x" } }),
        "packages/ui/package.json": packageJson({ name: "@acme/ui" }),
      },
    })
    const loader = new RepositoryStructureLoader(client)

    const structure = await loader.load(repository, files)

    const paths = structure.projects.map((p) => p.path).sort()
    expect(paths).toEqual([".", "apps/web", "packages/ui"])
    expect(
      structure.projects.find((p) => p.path === "packages/ui"),
    ).toMatchObject({ role: "package-candidate", packageName: "@acme/ui" })
  })

  it("resolves a simple pnpm-workspace.yaml packages pattern", async () => {
    const files = snapshot(
      { "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n' },
      ["pnpm-workspace.yaml"],
      ["apps"],
    )
    const client = createFakeClient({
      directories: { apps: [dirEntry("apps/web")] },
      files: {
        "apps/web/package.json": packageJson({ dependencies: { vite: "x" } }),
      },
    })
    const loader = new RepositoryStructureLoader(client)

    const structure = await loader.load(repository, files)

    expect(structure.projects.map((p) => p.path)).toEqual([".", "apps/web"])
    expect(structure.layout).toBe("workspace")
  })

  it("warns on a malformed workspaces declaration instead of crashing", async () => {
    const files = snapshot(
      { "package.json": packageJson({ workspaces: { nope: true } }) },
      ["package.json"],
    )
    const client = createFakeClient()
    const loader = new RepositoryStructureLoader(client)

    const structure = await loader.load(repository, files)

    expect(
      structure.warnings.some((w) => w.includes("unsupported shape")),
    ).toBe(true)
    expect(structure.projects.map((p) => p.path)).toEqual(["."])
  })

  it("reports an unsupported complex pattern as a warning without guessing", async () => {
    const files = snapshot(
      { "package.json": packageJson({ workspaces: ["apps/**"] }) },
      ["package.json"],
    )
    const client = createFakeClient()
    const loader = new RepositoryStructureLoader(client)

    const structure = await loader.load(repository, files)

    expect(
      structure.warnings.some((w) =>
        w.includes("Unsupported workspace pattern"),
      ),
    ).toBe(true)
    expect(client.getRepositoryDirectoryEntries).not.toHaveBeenCalled()
  })

  it("detects a conventional frontend/package.json candidate without a workspace tool", async () => {
    const files = snapshot({}, [], ["frontend"])
    const client = createFakeClient({
      files: {
        "frontend/package.json": packageJson({ dependencies: { react: "x" } }),
      },
    })
    const loader = new RepositoryStructureLoader(client)

    const structure = await loader.load(repository, files)

    expect(structure.projects.map((p) => p.path)).toEqual([".", "frontend"])
    expect(structure.layout).toBe("multi-project")
  })

  it("detects a conventional web/package.json candidate", async () => {
    const files = snapshot({}, [], ["web"])
    const client = createFakeClient({
      files: {
        "web/package.json": packageJson({ dependencies: { vue: "x" } }),
      },
    })
    const loader = new RepositoryStructureLoader(client)

    const structure = await loader.load(repository, files)

    expect(structure.projects.map((p) => p.path)).toEqual([".", "web"])
  })

  it("produces multi-project candidates for frontend + backend without a workspace manager", async () => {
    const files = snapshot({}, [], ["frontend", "backend"])
    const client = createFakeClient({
      files: {
        "frontend/package.json": packageJson({ dependencies: { react: "x" } }),
        "backend/package.json": packageJson({ dependencies: { express: "x" } }),
      },
    })
    const loader = new RepositoryStructureLoader(client)

    const structure = await loader.load(repository, files)

    expect(structure.layout).toBe("multi-project")
    expect(structure.projects.map((p) => p.path).sort()).toEqual([
      ".",
      "backend",
      "frontend",
    ])
  })

  it("does not probe a bare conventional directory that a wildcard pattern already covers", async () => {
    const files = snapshot(
      { "package.json": packageJson({ workspaces: ["apps/*"] }) },
      ["package.json"],
      ["apps"],
    )
    const client = createFakeClient({
      directories: { apps: [dirEntry("apps/web")] },
      files: {
        "apps/web/package.json": packageJson({ dependencies: { vite: "x" } }),
      },
    })
    const loader = new RepositoryStructureLoader(client)

    await loader.load(repository, files)

    expect(client.getRepositoryTextFile).not.toHaveBeenCalledWith(
      repository,
      "apps/package.json",
      expect.anything(),
      expect.anything(),
    )
  })

  it("keeps a malformed nested package.json as a warning-carrying candidate", async () => {
    const files = snapshot({}, [], ["frontend"])
    const client = createFakeClient({ files: { "frontend/package.json": "{" } })
    const loader = new RepositoryStructureLoader(client)

    const structure = await loader.load(repository, files)

    const candidate = structure.projects.find((p) => p.path === "frontend")
    expect(candidate?.role).toBe("unknown")
    expect(candidate?.warnings[0]).toContain("invalid JSON")
    expect(structure.complete).toBe(true)
  })

  it("handles a nested package.json request failure (e.g. oversized) as a warning, not a crash", async () => {
    const files = snapshot({}, [], ["frontend"])
    const client = createFakeClient({
      fileErrors: {
        "frontend/package.json": new GitHubApiError(
          "invalid-response",
          "frontend/package.json exceeds Peephole's byte limit.",
        ),
      },
    })
    const loader = new RepositoryStructureLoader(client)

    const structure = await loader.load(repository, files)

    expect(structure.complete).toBe(false)
    expect(structure.warnings.some((w) => w.includes("byte limit"))).toBe(true)
    expect(structure.projects.map((p) => p.path)).toEqual(["."])
  })

  it("never recursively lists a discovered subdirectory", async () => {
    const files = snapshot(
      { "package.json": packageJson({ workspaces: ["apps/*"] }) },
      ["package.json"],
      ["apps"],
    )
    const client = createFakeClient({
      directories: { apps: [dirEntry("apps/web")] },
      files: {
        "apps/web/package.json": packageJson({ dependencies: { vite: "x" } }),
      },
    })
    const loader = new RepositoryStructureLoader(client)

    await loader.load(repository, files)

    expect(client.getRepositoryDirectoryEntries).toHaveBeenCalledTimes(1)
    expect(client.getRepositoryDirectoryEntries).not.toHaveBeenCalledWith(
      repository,
      "apps/web",
      expect.anything(),
    )
  })

  it("excludes symlink and submodule entries from wildcard expansion", async () => {
    const files = snapshot(
      { "package.json": packageJson({ workspaces: ["apps/*"] }) },
      ["package.json"],
      ["apps"],
    )
    const client = createFakeClient({
      directories: {
        apps: [
          dirEntry("apps/web", "dir"),
          dirEntry("apps/vendored", "symlink"),
          dirEntry("apps/embedded", "submodule"),
          dirEntry("apps/README.md", "file"),
        ],
      },
      files: {
        "apps/web/package.json": packageJson({ dependencies: { vite: "x" } }),
      },
    })
    const loader = new RepositoryStructureLoader(client)

    const structure = await loader.load(repository, files)

    expect(structure.projects.map((p) => p.path)).toEqual([".", "apps/web"])
    expect(client.getRepositoryTextFile).toHaveBeenCalledTimes(1)
  })

  it("bounds the number of wildcard parent directories listed", async () => {
    const manyPatterns = Array.from(
      { length: MAX_STRUCTURE_DIRECTORY_LISTINGS + 5 },
      (_, index) => `dir${index}/*`,
    )
    const files = snapshot(
      { "package.json": packageJson({ workspaces: manyPatterns }) },
      ["package.json"],
    )
    const client = createFakeClient({
      directories: Object.fromEntries(
        manyPatterns.map((pattern) => {
          const dir = pattern.replace("/*", "")
          return [dir, [dirEntry(`${dir}/one`)]]
        }),
      ),
    })
    const loader = new RepositoryStructureLoader(client)

    const structure = await loader.load(repository, files)

    expect(client.getRepositoryDirectoryEntries).toHaveBeenCalledTimes(
      MAX_STRUCTURE_DIRECTORY_LISTINGS,
    )
    expect(structure.truncated).toBe(true)
  })

  it("bounds the number of candidate package.json probes", async () => {
    const entries = Array.from(
      { length: MAX_STRUCTURE_CANDIDATE_PROBES + 5 },
      (_, index) => dirEntry(`apps/app-${index}`),
    )
    const files = snapshot(
      { "package.json": packageJson({ workspaces: ["apps/*"] }) },
      ["package.json"],
      ["apps"],
    )
    const client = createFakeClient({
      directories: { apps: entries },
      files: Object.fromEntries(
        entries.map((entry) => [
          `${entry.path}/package.json`,
          packageJson({ dependencies: { vite: "x" } }),
        ]),
      ),
    })
    const loader = new RepositoryStructureLoader(client)

    const structure = await loader.load(repository, files)

    expect(client.getRepositoryTextFile).toHaveBeenCalledTimes(
      MAX_STRUCTURE_CANDIDATE_PROBES,
    )
    expect(structure.truncated).toBe(true)
  })

  it("bounds the number of entries considered from a single directory listing", async () => {
    const entries = Array.from(
      { length: MAX_STRUCTURE_DIRECTORY_ENTRIES + 10 },
      (_, index) => dirEntry(`apps/app-${index}`),
    )
    const files = snapshot(
      { "package.json": packageJson({ workspaces: ["apps/*"] }) },
      ["package.json"],
      ["apps"],
    )
    const client = createFakeClient({ directories: { apps: entries } })
    const loader = new RepositoryStructureLoader(client)

    const structure = await loader.load(repository, files)

    expect(structure.truncated).toBe(true)
  })

  it("uses the repository's resolved commit metadata for every read", async () => {
    const files = snapshot(
      { "package.json": packageJson({ workspaces: ["apps/*"] }) },
      ["package.json"],
      ["apps"],
    )
    const client = createFakeClient({
      directories: { apps: [dirEntry("apps/web")] },
      files: {
        "apps/web/package.json": packageJson({ dependencies: { vite: "x" } }),
      },
    })
    const loader = new RepositoryStructureLoader(client)

    await loader.load(repository, files)

    expect(client.getRepositoryDirectoryEntries).toHaveBeenCalledWith(
      repository,
      "apps",
      undefined,
    )
    expect(client.getRepositoryTextFile).toHaveBeenCalledWith(
      repository,
      "apps/web/package.json",
      expect.any(Number),
      undefined,
    )
  })

  it("propagates an abort instead of swallowing it as a warning", async () => {
    const files = snapshot(
      { "package.json": packageJson({ workspaces: ["apps/*"] }) },
      ["package.json"],
      ["apps"],
    )
    const abortError = new DOMException("aborted", "AbortError")
    const client = createFakeClient({
      fileErrors: {},
    })
    client.getRepositoryDirectoryEntries.mockRejectedValueOnce(abortError)
    const loader = new RepositoryStructureLoader(client)

    await expect(loader.load(repository, files)).rejects.toBe(abortError)
  })
})
