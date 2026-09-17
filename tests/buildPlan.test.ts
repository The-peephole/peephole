import { describe, expect, it } from "vitest"

import {
  createBuildPlanFromAnalysis,
  createBuildPlanFromTargetAnalysis,
  validateBuildPlan,
} from "../core/preview/buildAdapters"
import {
  InvalidBuildPlanError,
  createBuildCacheKey,
  validateBuildPlanShape,
} from "../core/preview/buildPlan"
import type { BuildPlan } from "../types/preview"
import { supportedAnalysis } from "./analysisFixture"

const plan: BuildPlan = {
  contractVersion: "static-v1",
  repository: {
    repositoryId: 1,
    owner: "acme",
    name: "web",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
  },
  sourceRoot: ".",
  packageManager: "npm",
  installCommand: "npm ci",
  buildCommand: "npm run build",
  outputDirectory: "dist",
}

describe("build plan", () => {
  it.each(["vue-vite", "svelte-vite"] as const)(
    "rejects stale positive analysis for %s",
    (framework) => {
      expect(
        createBuildPlanFromAnalysis({
          ...supportedAnalysis,
          technologies: { ...supportedAnalysis.technologies, framework },
        }),
      ).toBeNull()
    },
  )
  it("creates a normalized plan only from compatible analysis", () => {
    expect(createBuildPlanFromAnalysis(supportedAnalysis)).toEqual({
      contractVersion: "static-v1",
      repository: {
        repositoryId: supportedAnalysis.repository.repositoryId,
        owner: supportedAnalysis.repository.owner,
        name: supportedAnalysis.repository.repo,
        commitSha: supportedAnalysis.repository.commitSha,
      },
      sourceRoot: ".",
      packageManager: "npm",
      installCommand: "npm ci",
      buildCommand: "npm run build",
      outputDirectory: "dist",
    })

    expect(
      createBuildPlanFromAnalysis({
        ...supportedAnalysis,
        preview: {
          ...supportedAnalysis.preview,
          blockers: [
            { code: "SECRET_ENV_REQUIRED", message: "Secret required." },
          ],
        },
      }),
    ).toBeNull()
  })

  it("rejects arbitrary commands, source roots, and output traversal", () => {
    expect(() =>
      validateBuildPlan({ ...plan, buildCommand: "node arbitrary.js" }),
    ).toThrow(InvalidBuildPlanError)
    expect(() =>
      validateBuildPlan({ ...plan, sourceRoot: "apps/web" as "." }),
    ).toThrow("Only the repository root")
    expect(() =>
      validateBuildPlan({ ...plan, outputDirectory: "../outside" }),
    ).toThrow("safe repository-relative")
  })

  it("allows package-free static plans without commands", () => {
    expect(
      validateBuildPlan({
        ...plan,
        packageManager: "none",
        installCommand: null,
        buildCommand: null,
        outputDirectory: ".",
      }),
    ).toMatchObject({ packageManager: "none", outputDirectory: "." })
  })

  it("creates a static-v2 nested React Vite npm plan with target-local commands", () => {
    const nested = createBuildPlanFromTargetAnalysis({
      ...supportedAnalysis,
      targetAnalyzerVersion: "test",
      target: { sourceRoot: "apps/web" },
      preview: {
        ...supportedAnalysis.preview,
        contractVersion: "static-v2",
      },
    })

    expect(nested).toMatchObject({
      contractVersion: "static-v2",
      sourceRoot: "apps/web",
      installCommand: "npm ci",
      buildCommand: "npm run build",
      outputDirectory: "dist",
    })
  })

  it.each([
    "../web",
    "apps/../web",
    "C:/web",
    "https://example.com/web",
    "apps\\web",
    "apps/%2e%2e/web",
    "apps/web\u0000",
  ])("rejects unsafe static-v2 source root %j", (sourceRoot) => {
    expect(() =>
      validateBuildPlan({
        ...plan,
        contractVersion: "static-v2",
        sourceRoot,
      }),
    ).toThrow(InvalidBuildPlanError)
  })

  it("rejects package-manager and command combinations without an adapter", () => {
    const unsupportedPlan: BuildPlan = {
      ...plan,
      packageManager: "yarn",
      installCommand: "yarn install --immutable",
      buildCommand: "yarn build",
    }

    expect(validateBuildPlanShape(unsupportedPlan)).toEqual(unsupportedPlan)
    expect(() => validateBuildPlan(unsupportedPlan)).toThrow(
      "No registered build adapter",
    )
    expect(() =>
      validateBuildPlan({ ...plan, installCommand: "npm install" }),
    ).toThrow(InvalidBuildPlanError)
  })

  it("keys artifacts by commit, normalized plan, and runner version", async () => {
    const first = await createBuildCacheKey(plan, "runner-v1")

    expect(first).toHaveLength(64)
    await expect(createBuildCacheKey(plan, "runner-v1")).resolves.toBe(first)
    await expect(
      createBuildCacheKey(
        {
          ...plan,
          repository: {
            ...plan.repository,
            commitSha: "abcdef0123456789abcdef0123456789abcdef01",
          },
        },
        "runner-v1",
      ),
    ).resolves.not.toBe(first)
    await expect(createBuildCacheKey(plan, "runner-v2")).resolves.not.toBe(
      first,
    )
    await expect(
      createBuildCacheKey({ ...plan, outputDirectory: "build" }, "runner-v1"),
    ).resolves.not.toBe(first)
    await expect(
      createBuildCacheKey(
        {
          ...plan,
          contractVersion: "static-v2",
          sourceRoot: "apps/web",
        },
        "runner-v1",
      ),
    ).resolves.not.toBe(first)
  })
})
