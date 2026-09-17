import { describe, expect, it } from "vitest"

import {
  BUILD_ADAPTERS,
  AmbiguousBuildAdapterError,
  BuildAdapterResolver,
  createBuildPlanFromAnalysis,
  reactViteNpmBuildAdapter,
  staticHtmlBuildAdapter,
  type BuildAdapter,
} from "../core/preview/buildAdapters"
import type { PackageManager, RepositoryAnalysis } from "../types/analysis"
import { supportedAnalysis } from "./analysisFixture"

describe("build adapters", () => {
  it("matches package-free root static HTML with only the static adapter", () => {
    const analysis = staticAnalysis()

    expect(matchingAdapterIds(analysis)).toEqual(["static-html-v1"])
    expect(createBuildPlanFromAnalysis(analysis)).toEqual({
      contractVersion: "static-v1",
      repository: {
        repositoryId: analysis.repository.repositoryId,
        owner: analysis.repository.owner,
        name: analysis.repository.repo,
        commitSha: analysis.repository.commitSha,
      },
      sourceRoot: ".",
      packageManager: "none",
      installCommand: null,
      buildCommand: null,
      outputDirectory: ".",
    })
  })

  it("matches root React Vite npm with only the npm adapter", () => {
    expect(matchingAdapterIds(supportedAnalysis)).toEqual(["vite-react-npm-v1"])
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
  })

  it.each(["vue-vite", "svelte-vite"] as const)(
    "does not implement %s with npm",
    (framework) => {
      const analysis = withTarget(framework, "npm", [
        "package.json",
        "package-lock.json",
      ])

      expect(matchingAdapterIds(analysis)).toEqual([])
      expect(createBuildPlanFromAnalysis(analysis)).toBeNull()
    },
  )

  it.each(["pnpm", "yarn", "bun"] as const)(
    "does not implement React Vite with %s",
    (packageManager) => {
      const analysis = withTarget("react-vite", packageManager, [
        "package.json",
        lockfileFor(packageManager),
      ])

      expect(matchingAdapterIds(analysis)).toEqual([])
      expect(createBuildPlanFromAnalysis(analysis)).toBeNull()
    },
  )

  it("requires a root package-lock for the React Vite npm adapter", () => {
    const analysis = withTarget("react-vite", "npm", ["package.json"])

    expect(matchingAdapterIds(analysis)).toEqual([])
    expect(createBuildPlanFromAnalysis(analysis)).toBeNull()
  })

  it("never creates a plan from a blocked analysis", () => {
    const analysis: RepositoryAnalysis = {
      ...supportedAnalysis,
      preview: {
        ...supportedAnalysis.preview,
        mode: "unsupported",
        blockers: [
          { code: "SECRET_ENV_REQUIRED", message: "Secret required." },
        ],
      },
    }

    expect(new BuildAdapterResolver().resolve(analysis)?.id).toBe(
      "vite-react-npm-v1",
    )
    expect(createBuildPlanFromAnalysis(analysis)).toBeNull()
  })

  it("returns null when no registered adapter matches", () => {
    expect(
      new BuildAdapterResolver().resolve(
        withTarget("react-vite", "pnpm", ["package.json", "pnpm-lock.yaml"]),
      ),
    ).toBeNull()
  })

  it("throws instead of silently selecting the first overlapping adapter", () => {
    const first: BuildAdapter = {
      ...staticHtmlBuildAdapter,
      matches: () => true,
    }
    const second: BuildAdapter = {
      ...reactViteNpmBuildAdapter,
      matches: () => true,
    }
    const resolver = new BuildAdapterResolver([first, second])

    expect(() => resolver.resolve(supportedAnalysis)).toThrow(
      AmbiguousBuildAdapterError,
    )
  })

  it("does not select a nested structure candidate", () => {
    const analysis: RepositoryAnalysis = {
      ...withTarget("unknown", "none", ["package.json"]),
      workspace: {
        monorepo: true,
        ambiguous: true,
        evidence: ["package.json workspaces detected"],
      },
      structure: {
        layout: "multi-project",
        projects: [nestedCandidate("frontend"), nestedCandidate("backend")],
        workspaceEvidence: ["package.json workspaces detected"],
        warnings: [],
        complete: true,
        truncated: false,
      },
      preview: {
        ...supportedAnalysis.preview,
        mode: "unsupported",
        packageManager: "none",
        installCommand: null,
        buildCommand: null,
        outputDirectory: null,
        blockers: [
          {
            code: "AMBIGUOUS_WORKSPACE",
            message: "Target selection is not implemented.",
          },
        ],
      },
    }

    expect(new BuildAdapterResolver().resolve(analysis)).toBeNull()
    expect(createBuildPlanFromAnalysis(analysis)).toBeNull()
  })
})

function matchingAdapterIds(analysis: RepositoryAnalysis) {
  return BUILD_ADAPTERS.filter((adapter) => adapter.matches(analysis)).map(
    ({ id }) => id,
  )
}

function staticAnalysis(): RepositoryAnalysis {
  return {
    ...supportedAnalysis,
    technologies: {
      framework: "static",
      typescript: false,
      evidence: ["root index.html detected without package.json"],
    },
    packageManager: "none",
    runtime: {
      installCommand: null,
      devCommand: null,
      buildCommand: null,
      outputDirectory: ".",
      evidence: ["Static root can be published without a package build"],
      warnings: [],
    },
    preview: {
      contractVersion: "static-v1",
      mode: "native-static-build",
      packageManager: "none",
      installCommand: null,
      buildCommand: null,
      outputDirectory: ".",
      evidence: [],
      blockers: [],
    },
    inspectedFiles: ["index.html"],
  }
}

function withTarget(
  framework: RepositoryAnalysis["technologies"]["framework"],
  packageManager: PackageManager,
  inspectedFiles: string[],
): RepositoryAnalysis {
  return {
    ...supportedAnalysis,
    technologies: { ...supportedAnalysis.technologies, framework },
    packageManager,
    preview: {
      ...supportedAnalysis.preview,
      packageManager,
    },
    inspectedFiles,
  }
}

function lockfileFor(packageManager: "pnpm" | "yarn" | "bun"): string {
  return {
    pnpm: "pnpm-lock.yaml",
    yarn: "yarn.lock",
    bun: "bun.lock",
  }[packageManager]
}

function nestedCandidate(path: string) {
  return {
    path,
    isRoot: false,
    role: "project-candidate" as const,
    hasPackageJson: true,
    packageName: path,
    evidence: ["package.json detected"],
    warnings: [],
  }
}
