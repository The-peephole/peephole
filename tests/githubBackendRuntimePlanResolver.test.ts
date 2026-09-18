import { describe, expect, it, vi } from "vitest"

import { GitHubBackendRuntimePlanResolver } from "../services/backend-runtime-api/githubRuntimePlanResolver"
import type { GitHubClient } from "../core/github/client"

const repository = {
  repositoryId: 1,
  owner: "acme",
  name: "web",
  commitSha: "a".repeat(40),
}

const metadata = {
  repositoryId: 1,
  owner: "acme",
  repo: "web",
  defaultBranch: "main",
  commitSha: "a".repeat(40),
  homepage: null,
}

const packageJson = JSON.stringify({
  name: "web",
  dependencies: { express: "1.0.0" },
  scripts: { start: "node src/server.js" },
})

function github(
  files: Record<string, string | null>,
  failures: Record<string, Error> = {},
) {
  return {
    getRepositoryMetadataAtCommit: vi.fn().mockResolvedValue(metadata),
    getRepositoryTextFile: vi.fn(async (_metadata, filePath: string) => {
      const failure = failures[filePath]
      if (failure) throw failure
      return files[filePath] ?? null
    }),
  } as unknown as GitHubClient
}

function qualifyingFiles(overrides: Record<string, string | null> = {}) {
  return {
    "package.json": packageJson,
    "package-lock.json": "{}",
    ...overrides,
  }
}

describe("GitHubBackendRuntimePlanResolver", () => {
  it("allows confirmed-absent env templates for an otherwise qualifying backend", async () => {
    const resolver = new GitHubBackendRuntimePlanResolver(
      github(qualifyingFiles()),
    )

    await expect(resolver.resolve(repository, ".")).resolves.toMatchObject({
      packageManager: "npm",
      start: { command: "node", args: ["src/server.js"] },
    })
  })

  it("rejects an env template containing an unsupported API key", async () => {
    const resolver = new GitHubBackendRuntimePlanResolver(
      github(qualifyingFiles({ ".env.example": "API_KEY=example" })),
    )

    await expect(resolver.resolve(repository, ".")).resolves.toBeNull()
  })

  it.each(["network error", "rate limit"])(
    "fails closed when an env authorization read has a %s",
    async (_label) => {
      const resolver = new GitHubBackendRuntimePlanResolver(
        github(qualifyingFiles(), { ".env.example": new Error(_label) }),
      )

      await expect(resolver.resolve(repository, ".")).resolves.toBeNull()
    },
  )

  it("fails closed when package-lock authorization evidence cannot be read", async () => {
    const resolver = new GitHubBackendRuntimePlanResolver(
      github(qualifyingFiles(), { "package-lock.json": new Error("network") }),
    )

    await expect(resolver.resolve(repository, ".")).resolves.toBeNull()
  })

  it("fails closed when package.json authorization evidence cannot be read", async () => {
    const resolver = new GitHubBackendRuntimePlanResolver(
      github(qualifyingFiles(), { "package.json": new Error("network") }),
    )

    await expect(resolver.resolve(repository, ".")).resolves.toBeNull()
  })

  it("propagates aborts rather than converting them into unsupported", async () => {
    const aborted = new Error("cancelled")
    aborted.name = "AbortError"
    const resolver = new GitHubBackendRuntimePlanResolver(
      github(qualifyingFiles(), { ".env.example": aborted }),
    )

    await expect(resolver.resolve(repository, ".")).rejects.toBe(aborted)
  })

  it.each(["pnpm@9.0.0", "yarn@4.0.0", "bun@1.0.0"])(
    "rejects an explicitly declared %s package manager",
    async (packageManager) => {
      const resolver = new GitHubBackendRuntimePlanResolver(
        github(
          qualifyingFiles({
            "package.json": JSON.stringify({
              name: "web",
              packageManager,
              dependencies: { express: "1.0.0" },
              scripts: { start: "node src/server.js" },
            }),
          }),
        ),
      )

      await expect(resolver.resolve(repository, ".")).resolves.toBeNull()
    },
  )

  it("accepts an explicit npm version declaration", async () => {
    const resolver = new GitHubBackendRuntimePlanResolver(
      github(
        qualifyingFiles({
          "package.json": JSON.stringify({
            name: "web",
            packageManager: "npm@10.0.0",
            dependencies: { express: "1.0.0" },
            scripts: { start: "node src/server.js" },
          }),
        }),
      ),
    )

    await expect(resolver.resolve(repository, ".")).resolves.not.toBeNull()
  })
})
