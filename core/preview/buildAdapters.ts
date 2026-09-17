import {
  PREVIEW_CONTRACT_VERSION,
  LEGACY_PREVIEW_CONTRACT_VERSION,
  TARGET_ANALYZER_VERSION,
  type BuildTargetAnalysis,
  type Framework,
  type PackageManager,
  type RepositoryAnalysis,
} from "../../types/analysis"
import type { BuildPlan } from "../../types/preview"
import { InvalidBuildPlanError, validateBuildPlanShape } from "./buildPlan"

export type BuildAdapterId = "static-html-v1" | "vite-react-npm-v1"

export interface BuildAdapterMatchInput {
  technologies: { framework: Framework }
  packageManager: PackageManager
  inspectedFiles: readonly string[]
}

export interface BuildAdapter {
  readonly id: BuildAdapterId
  matches(input: BuildAdapterMatchInput): boolean
  createPlan(analysis: BuildTargetAnalysis): BuildPlan
  validatePlan(plan: BuildPlan): BuildPlan
}

export class AmbiguousBuildAdapterError extends Error {
  constructor(readonly adapterIds: readonly BuildAdapterId[]) {
    super(`Multiple build adapters matched: ${adapterIds.join(", ")}.`)
    this.name = "AmbiguousBuildAdapterError"
  }
}

export const staticHtmlBuildAdapter: BuildAdapter = {
  id: "static-html-v1",
  matches(input) {
    return (
      input.technologies.framework === "static" &&
      input.packageManager === "none" &&
      input.inspectedFiles.includes("index.html") &&
      !input.inspectedFiles.includes("package.json")
    )
  },
  createPlan(analysis) {
    assertAnalysisCanCreatePlan(this, analysis)

    if (analysis.target.sourceRoot !== ".") {
      throw new InvalidBuildPlanError(
        "Static HTML previews are supported only at the repository root.",
      )
    }

    if (
      analysis.preview.packageManager !== "none" ||
      analysis.preview.installCommand !== null ||
      analysis.preview.buildCommand !== null ||
      analysis.preview.outputDirectory !== "."
    ) {
      throw new InvalidBuildPlanError(
        "Static HTML analysis does not describe the expected package-free root output.",
      )
    }

    return this.validatePlan({
      ...repositoryPlanFields(analysis),
      packageManager: "none",
      installCommand: null,
      buildCommand: null,
      outputDirectory: ".",
    })
  },
  validatePlan(plan) {
    const value = validateBuildPlanShape(plan)

    if (
      value.sourceRoot !== "." ||
      value.packageManager !== "none" ||
      value.installCommand !== null ||
      value.buildCommand !== null ||
      value.outputDirectory !== "."
    ) {
      throw new InvalidBuildPlanError(
        "Static HTML plans must publish the repository root without install or build commands.",
      )
    }

    return value
  },
}

export const reactViteNpmBuildAdapter: BuildAdapter = {
  id: "vite-react-npm-v1",
  matches(input) {
    return (
      input.technologies.framework === "react-vite" &&
      input.packageManager === "npm" &&
      input.inspectedFiles.includes("package-lock.json")
    )
  },
  createPlan(analysis) {
    assertAnalysisCanCreatePlan(this, analysis)

    if (
      analysis.preview.packageManager !== "npm" ||
      analysis.preview.installCommand !== "npm ci" ||
      analysis.preview.buildCommand !== "npm run build" ||
      !analysis.preview.outputDirectory
    ) {
      throw new InvalidBuildPlanError(
        "React Vite npm analysis does not describe the expected deterministic build.",
      )
    }

    return this.validatePlan({
      ...repositoryPlanFields(analysis),
      packageManager: "npm",
      installCommand: "npm ci",
      buildCommand: "npm run build",
      outputDirectory: analysis.preview.outputDirectory,
    })
  },
  validatePlan(plan) {
    const value = validateBuildPlanShape(plan)

    if (
      value.packageManager !== "npm" ||
      value.installCommand !== "npm ci" ||
      value.buildCommand !== "npm run build"
    ) {
      throw new InvalidBuildPlanError(
        "React Vite npm plans require npm ci, npm run build, and a static output directory.",
      )
    }

    return value
  },
}

export const BUILD_ADAPTERS: readonly BuildAdapter[] = Object.freeze([
  staticHtmlBuildAdapter,
  reactViteNpmBuildAdapter,
])

export class BuildAdapterResolver {
  constructor(
    private readonly adapters: readonly BuildAdapter[] = BUILD_ADAPTERS,
  ) {}

  resolve(input: BuildAdapterMatchInput): BuildAdapter | null {
    const matches = this.adapters.filter((adapter) => adapter.matches(input))

    if (matches.length > 1) {
      throw new AmbiguousBuildAdapterError(matches.map(({ id }) => id))
    }

    return matches[0] ?? null
  }

  createPlan(analysis: BuildTargetAnalysis): BuildPlan | null {
    const adapter = this.resolve(analysis)

    if (!adapter || !analysisCanCreatePlan(analysis)) {
      return null
    }

    return adapter.createPlan(analysis)
  }

  validatePlan(plan: BuildPlan): BuildPlan {
    const value = validateBuildPlanShape(plan)
    const matches = this.adapters.filter((adapter) => {
      try {
        adapter.validatePlan(value)
        return true
      } catch (error) {
        if (error instanceof InvalidBuildPlanError) return false
        throw error
      }
    })

    if (matches.length === 0) {
      throw new InvalidBuildPlanError(
        "No registered build adapter accepts this build plan.",
      )
    }

    if (matches.length > 1) {
      throw new AmbiguousBuildAdapterError(matches.map(({ id }) => id))
    }

    const adapter = matches[0]

    if (!adapter) {
      throw new InvalidBuildPlanError("A matched build adapter was not found.")
    }

    return adapter.validatePlan(value)
  }
}

export const buildAdapterResolver = new BuildAdapterResolver()

export function createBuildPlanFromAnalysis(
  analysis: RepositoryAnalysis,
): BuildPlan | null {
  return createBuildPlanFromTargetAnalysis(toRootBuildTargetAnalysis(analysis))
}

export function createBuildPlanFromTargetAnalysis(
  analysis: BuildTargetAnalysis,
): BuildPlan | null {
  return buildAdapterResolver.createPlan(analysis)
}

export function validateBuildPlan(plan: BuildPlan): BuildPlan {
  return buildAdapterResolver.validatePlan(plan)
}

export function isBuildAdapterAvailable(
  input: BuildAdapterMatchInput,
): boolean {
  return buildAdapterResolver.resolve(input) !== null
}

function analysisCanCreatePlan(analysis: BuildTargetAnalysis): boolean {
  return (
    analysis.preview.mode === "native-static-build" &&
    analysis.preview.blockers.length === 0 &&
    (analysis.preview.contractVersion === PREVIEW_CONTRACT_VERSION ||
      (analysis.preview.contractVersion === LEGACY_PREVIEW_CONTRACT_VERSION &&
        analysis.target.sourceRoot === "."))
  )
}

function assertAnalysisCanCreatePlan(
  adapter: BuildAdapter,
  analysis: BuildTargetAnalysis,
): void {
  if (!adapter.matches(analysis) || !analysisCanCreatePlan(analysis)) {
    throw new InvalidBuildPlanError(
      `Analysis does not satisfy the ${adapter.id} build adapter.`,
    )
  }
}

function repositoryPlanFields(
  analysis: BuildTargetAnalysis,
): Pick<BuildPlan, "contractVersion" | "repository" | "sourceRoot"> {
  return {
    contractVersion: analysis.preview.contractVersion,
    repository: {
      repositoryId: analysis.repository.repositoryId,
      owner: analysis.repository.owner,
      name: analysis.repository.repo,
      commitSha: analysis.repository.commitSha,
    },
    sourceRoot: analysis.target.sourceRoot,
  }
}

export function toRootBuildTargetAnalysis(
  analysis: RepositoryAnalysis,
): BuildTargetAnalysis {
  return {
    repository: analysis.repository,
    targetAnalyzerVersion: TARGET_ANALYZER_VERSION,
    target: { sourceRoot: "." },
    technologies: analysis.technologies,
    packageManager: analysis.packageManager,
    runtime: analysis.runtime,
    environment: analysis.environment,
    preview: analysis.preview,
    inspectedFiles: analysis.inspectedFiles,
    warnings: analysis.warnings,
  }
}
