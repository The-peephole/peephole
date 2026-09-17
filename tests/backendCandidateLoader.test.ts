import { describe, expect, it, vi } from "vitest"

import {
  BackendCandidateLoader,
  MAX_BACKEND_CANDIDATES,
  MAX_BACKEND_ENV_TEMPLATE_READS,
} from "../core/github/backendCandidateLoader"

const repository = {
  repositoryId: 1,
  owner: "acme",
  repo: "web",
  defaultBranch: "main",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  homepage: null,
}

function expressPackageJson(): string {
  return JSON.stringify({
    name: "backend",
    dependencies: { express: "latest" },
    scripts: { start: "node src/server.js" },
  })
}

describe("BackendCandidateLoader", () => {
  it("detects a backend candidate from a fetched package.json", async () => {
    const getRepositoryTextFile = vi
      .fn()
      .mockImplementation(async (_repo, path: string) => {
        if (path === "backend/package.json") return expressPackageJson()
        return null
      })
    const loader = new BackendCandidateLoader({ getRepositoryTextFile })

    const result = await loader.load(repository, ["backend"])

    expect(result.status).toBe("detected")
    expect(result.candidates).toMatchObject([
      { sourceRoot: "backend", framework: "express" },
    ])
  })

  it("reports not-detected for a candidate with no package.json", async () => {
    const getRepositoryTextFile = vi.fn().mockResolvedValue(null)
    const loader = new BackendCandidateLoader({ getRepositoryTextFile })

    const result = await loader.load(repository, ["frontend"])

    expect(result.status).toBe("not-detected")
  })

  it("includes an env template read for a candidate that qualifies", async () => {
    const getRepositoryTextFile = vi
      .fn()
      .mockImplementation(async (_repo, path: string) => {
        if (path === "backend/package.json") return expressPackageJson()
        if (path === "backend/.env.example") return "PORT=3000\n"
        return null
      })
    const loader = new BackendCandidateLoader({ getRepositoryTextFile })

    const result = await loader.load(repository, ["backend"])

    expect(result.candidates[0]?.environmentRequirements).toMatchObject([
      { name: "PORT", sourceRoot: "backend" },
    ])
  })

  it("respects MAX_BACKEND_CANDIDATES and marks the result truncated", async () => {
    const getRepositoryTextFile = vi
      .fn()
      .mockImplementation(async (_repo, path: string) =>
        path.endsWith("/package.json") ? expressPackageJson() : null,
      )
    const loader = new BackendCandidateLoader({ getRepositoryTextFile })
    const paths = Array.from(
      { length: MAX_BACKEND_CANDIDATES + 3 },
      (_, i) => `c${i}`,
    )

    const result = await loader.load(repository, paths)

    expect(result.candidates).toHaveLength(MAX_BACKEND_CANDIDATES)
    expect(result.truncated).toBe(true)
  })

  it("respects MAX_BACKEND_ENV_TEMPLATE_READS across candidates", async () => {
    let envReads = 0
    const getRepositoryTextFile = vi
      .fn()
      .mockImplementation(async (_repo, path: string) => {
        if (path.endsWith("/package.json")) return expressPackageJson()
        envReads += 1
        return null
      })
    const loader = new BackendCandidateLoader({ getRepositoryTextFile })
    const paths = Array.from(
      { length: MAX_BACKEND_CANDIDATES },
      (_, i) => `c${i}`,
    )

    await loader.load(repository, paths)

    expect(envReads).toBeLessThanOrEqual(MAX_BACKEND_ENV_TEMPLATE_READS)
  })

  it("marks the result incomplete (not truncated) when a package.json read fails", async () => {
    const getRepositoryTextFile = vi
      .fn()
      .mockImplementation(async (_repo, path: string) => {
        if (path === "backend/package.json") {
          throw new Error("rate limited")
        }
        return null
      })
    const loader = new BackendCandidateLoader({ getRepositoryTextFile })

    const result = await loader.load(repository, ["backend"])

    expect(result.complete).toBe(false)
    expect(result.warnings.join(" ")).toContain("rate limited")
  })

  it("does not fail the whole load when a single env-template read fails", async () => {
    const getRepositoryTextFile = vi
      .fn()
      .mockImplementation(async (_repo, path: string) => {
        if (path === "backend/package.json") return expressPackageJson()
        throw new Error("boom")
      })
    const loader = new BackendCandidateLoader({ getRepositoryTextFile })

    const result = await loader.load(repository, ["backend"])

    expect(result.status).toBe("detected")
    expect(result.candidates[0]?.environmentRequirements).toEqual([])
  })

  it("reports not-detected/complete:false with the parse-error warning for a malformed nested package.json only", async () => {
    const getRepositoryTextFile = vi
      .fn()
      .mockImplementation(async (_repo, path: string) => {
        if (path === "backend/package.json") return "{ not valid json"
        return null
      })
    const loader = new BackendCandidateLoader({ getRepositoryTextFile })

    const result = await loader.load(repository, ["backend"])

    expect(result.status).toBe("not-detected")
    expect(result.candidates).toEqual([])
    expect(result.complete).toBe(false)
    expect(result.warnings.join(" ")).toContain(
      "backend/package.json could not be parsed",
    )
  })

  it("still detects a valid sibling candidate when another candidate's package.json is malformed", async () => {
    const getRepositoryTextFile = vi
      .fn()
      .mockImplementation(async (_repo, path: string) => {
        if (path === "backend/package.json") return expressPackageJson()
        if (path === "broken/package.json") return "{ not valid json"
        return null
      })
    const loader = new BackendCandidateLoader({ getRepositoryTextFile })

    const result = await loader.load(repository, ["backend", "broken"])

    expect(result.status).toBe("detected")
    expect(result.candidates).toMatchObject([
      { sourceRoot: "backend", framework: "express" },
    ])
    expect(result.complete).toBe(false)
    expect(result.warnings.join(" ")).toContain(
      "broken/package.json could not be parsed",
    )
  })

  it("does not probe env templates for a candidate whose package.json is malformed", async () => {
    const getRepositoryTextFile = vi
      .fn()
      .mockImplementation(async (_repo, path: string) => {
        if (path === "backend/package.json") return "{ not valid json"
        return null
      })
    const loader = new BackendCandidateLoader({ getRepositoryTextFile })

    await loader.load(repository, ["backend"])

    expect(
      getRepositoryTextFile.mock.calls.some((call) =>
        String(call[1]).includes(".env"),
      ),
    ).toBe(false)
  })

  it("propagates an abort instead of swallowing it", async () => {
    const abortError = new DOMException("aborted", "AbortError")
    const getRepositoryTextFile = vi.fn().mockRejectedValue(abortError)
    const loader = new BackendCandidateLoader({ getRepositoryTextFile })

    await expect(loader.load(repository, ["backend"])).rejects.toBe(abortError)
  })

  it("never lists a directory -- only fixed file paths are requested", async () => {
    const getRepositoryTextFile = vi.fn().mockResolvedValue(null)
    const loader = new BackendCandidateLoader({ getRepositoryTextFile })

    await loader.load(repository, ["backend", "apps/api"])

    for (const [, path] of getRepositoryTextFile.mock.calls) {
      expect(typeof path).toBe("string")
      expect(path).not.toContain("*")
    }
  })
})
