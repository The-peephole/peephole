import { describe, expect, it, vi } from "vitest"

import { GitHubBackendRuntimePlanResolver } from "../services/backend-runtime-api/githubRuntimePlanResolver"
import { BackendRuntimeControlPlane } from "../services/backend-runtime-api/controlPlane"
import {
  InMemoryBackendRuntimeQueue,
  InMemoryBackendRuntimeStore,
} from "../services/backend-runtime-api/inMemoryAdapters"
import { GitHubApiError, type GitHubClient } from "../core/github/client"

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

  it.each([
    new GitHubApiError("rate-limited", "GitHub API rate limit reached.", 403),
    new GitHubApiError("network", "GitHub could not be reached."),
    new GitHubApiError(
      "unavailable",
      "GitHub request failed with status 502.",
      502,
    ),
  ])(
    "propagates a GitHub $code failure from an env authorization read instead of treating it as unsupported",
    async (failure) => {
      const resolver = new GitHubBackendRuntimePlanResolver(
        github(qualifyingFiles(), { ".env.example": failure }),
      )

      await expect(resolver.resolve(repository, ".")).rejects.toBe(failure)
    },
  )

  it("propagates a GitHub upstream failure when package-lock authorization evidence cannot be read", async () => {
    const failure = new GitHubApiError(
      "rate-limited",
      "GitHub API rate limit reached.",
      429,
    )
    const resolver = new GitHubBackendRuntimePlanResolver(
      github(qualifyingFiles(), { "package-lock.json": failure }),
    )

    await expect(resolver.resolve(repository, ".")).rejects.toBe(failure)
  })

  it("propagates a GitHub upstream failure when package.json authorization evidence cannot be read", async () => {
    const failure = new GitHubApiError("network", "GitHub could not be reached.")
    const resolver = new GitHubBackendRuntimePlanResolver(
      github(qualifyingFiles(), { "package.json": failure }),
    )

    await expect(resolver.resolve(repository, ".")).rejects.toBe(failure)
  })

  it("still treats a confirmed missing optional file as absent, not an upstream failure", async () => {
    // getRepositoryTextFile itself returns null (never throws) for a
    // confirmed-404 file -- see core/github/client.ts requestOptionalJson.
    // package.json/package-lock.json/env templates are already covered by
    // `qualifyingFiles()`'s defaults resolving via `files`, not `failures`.
    const resolver = new GitHubBackendRuntimePlanResolver(
      github(qualifyingFiles({ ".env.example": null })),
    )

    await expect(resolver.resolve(repository, ".")).resolves.not.toBeNull()
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

  it("surfaces as a real 503 UPSTREAM_UNAVAILABLE through the actual control plane, not a 422 UNSUPPORTED_BACKEND", async () => {
    // Wires the real (fixed) resolver into the real control plane -- proves
    // the end-to-end fix, not just that each unit independently behaves as
    // expected in isolation.
    const resolver = new GitHubBackendRuntimePlanResolver(
      github(qualifyingFiles(), {
        "package.json": new GitHubApiError(
          "rate-limited",
          "GitHub API rate limit reached.",
          403,
          new Date("2026-01-01T00:01:00.000Z"),
        ),
      }),
    )
    const controlPlane = new BackendRuntimeControlPlane(
      resolver,
      new InMemoryBackendRuntimeStore(),
      new InMemoryBackendRuntimeQueue(),
      { now: () => new Date("2026-01-01T00:00:00.000Z") },
    )

    await expect(
      controlPlane.create(
        { repository, contractVersion: "backend-v1" },
        { subject: "user-1", ip: "203.0.113.10" },
      ),
    ).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      status: 503,
      retryAfterSeconds: 60,
    })
  })
})
