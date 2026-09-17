import { describe, expect, it } from "vitest"

import { analyzeBuildTarget } from "../core/analyzer/analyzeBuildTarget"
import type { RepositoryMetadata } from "../types/repository"

const repository: RepositoryMetadata = {
  repositoryId: 1,
  owner: "acme",
  repo: "platform",
  defaultBranch: "main",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  homepage: null,
}

describe("analyzeBuildTarget", () => {
  it("accepts an independently installable nested React Vite npm target", () => {
    const analysis = analyzeBuildTarget(
      repository,
      { sourceRoot: "apps/web" },
      reactFiles(true),
    )

    expect(analysis).toMatchObject({
      target: { sourceRoot: "apps/web" },
      packageManager: "npm",
      preview: {
        contractVersion: "static-v2",
        mode: "native-static-build",
        installCommand: "npm ci",
        buildCommand: "npm run build",
        outputDirectory: "dist",
        blockers: [],
      },
    })
  })

  it("blocks nested targets that depend on a shared root lockfile", () => {
    const analysis = analyzeBuildTarget(
      repository,
      { sourceRoot: "apps/web" },
      reactFiles(false),
    )

    expect(analysis.preview.blockers).toContainEqual(
      expect.objectContaining({
        code: "RUNNER_TARGET_UNAVAILABLE",
        message: expect.stringContaining("target"),
      }),
    )
  })

  it("does not turn backend packages into runnable previews", () => {
    const analysis = analyzeBuildTarget(
      repository,
      { sourceRoot: "apps/api" },
      {
        ...reactFiles(true),
        presentPaths: ["package.json", "package-lock.json"],
        textFiles: {
          "package.json": JSON.stringify({
            scripts: { build: "tsc" },
            dependencies: { express: "latest" },
          }),
        },
      },
    )

    expect(analysis.preview.mode).toBe("unsupported")
    expect(analysis.preview.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "BACKEND_REQUIRED" }),
        expect.objectContaining({ code: "UNSUPPORTED_FRAMEWORK" }),
      ]),
    )
  })
})

function reactFiles(withLockfile: boolean) {
  return {
    presentPaths: [
      "index.html",
      "package.json",
      "vite.config.ts",
      ...(withLockfile ? ["package-lock.json"] : []),
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
