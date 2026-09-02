import { describe, expect, it } from "vitest"

import {
  InvalidBuildPlanError,
  createBuildCacheKey,
  createBuildPlanFromAnalysis,
  validateBuildPlan,
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

  it("accepts the immutable Yarn install selected by package metadata", () => {
    expect(
      validateBuildPlan({
        ...plan,
        packageManager: "yarn",
        installCommand: "yarn install --immutable",
        buildCommand: "yarn build",
      }),
    ).toMatchObject({
      packageManager: "yarn",
      installCommand: "yarn install --immutable",
    })
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
  })
})
