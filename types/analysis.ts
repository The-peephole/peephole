import type { BackendDetection } from "./backend"
import type { EnvironmentRequirement } from "./environment"
import type { RepositoryMetadata, RepositoryRevisionTarget } from "./repository"
import type { RepositoryStructure } from "./structure"
import type { PreviewTarget } from "./target"

export const ANALYZER_VERSION = "0.1.5"
export const TARGET_ANALYZER_VERSION = "0.1.1"
export const LEGACY_PREVIEW_CONTRACT_VERSION = "static-v1"
export const PREVIEW_CONTRACT_VERSION = "static-v2"

export type Framework =
  | "static"
  | "react-vite"
  | "vue-vite"
  | "svelte-vite"
  | "wxt"
  | "next"
  | "react"
  | "unknown"

export type PackageManager =
  "npm" | "pnpm" | "yarn" | "bun" | "none" | "unknown"

export type PreviewMode =
  "existing-deployment" | "native-static-build" | "unsupported"

export interface PreviewBlocker {
  code:
    | "UNSUPPORTED_FRAMEWORK"
    | "RUNNER_TARGET_UNAVAILABLE"
    | "UNKNOWN_PACKAGE_MANAGER"
    | "CONFLICTING_LOCKFILES"
    | "MALFORMED_PACKAGE_JSON"
    | "MISSING_BUILD_COMMAND"
    | "UNKNOWN_OUTPUT_DIRECTORY"
    | "SECRET_ENV_REQUIRED"
    | "PERSISTENT_SERVER_REQUIRED"
    | "BACKEND_REQUIRED"
    | "AMBIGUOUS_WORKSPACE"
    | "ANALYSIS_INCOMPLETE"
  message: string
}

export interface RepositoryAnalysis {
  repository: RepositoryMetadata
  analyzerVersion: string
  technologies: {
    framework: Framework
    typescript: boolean
    evidence: string[]
  }
  packageManager: PackageManager
  runtime: {
    installCommand: string | null
    devCommand: string | null
    buildCommand: string | null
    outputDirectory: string | null
    evidence: string[]
    warnings: string[]
  }
  environment: {
    templateFound: boolean
    variables: string[]
    publicClientVariables: string[]
    secretLikeVariables: string[]
  }
  /**
   * Local, immutable, per-commit deployment *evidence* only -- never proof of
   * an actual live deployment. "declared" reflects `repository.homepage`
   * metadata alone; "confirmed" live-deployment status comes only from the
   * separate, mutable `RepositoryLiveDeploymentLoader`
   * (`types/deployment.ts`), which independently queries the GitHub
   * Deployments API and is never folded into this SHA-keyed analysis.
   */
  deployment: {
    status: "declared" | "configured" | "unknown"
    provider: "homepage" | "vercel" | "netlify" | null
    url: string | null
    evidence: string[]
  }
  workspace: {
    monorepo: boolean
    ambiguous: boolean
    evidence: string[]
  }
  structure: RepositoryStructure
  /**
   * Detection only -- never execution. See `types/backend.ts`. The root is
   * classified from data already fetched for the rest of this analysis;
   * nested candidates come from a separate bounded loader
   * (`core/github/backendCandidateLoader.ts`) and never fail this analysis
   * as a whole on their own.
   */
  backend: BackendDetection
  /**
   * Union of the root/selected target's environment requirements and every
   * detected backend candidate's own, each tagged with its source root.
   * Detection only -- see `types/environment.ts`.
   */
  environmentRequirements: EnvironmentRequirement[]
  preview: {
    contractVersion: string
    mode: PreviewMode
    packageManager: PackageManager
    installCommand: string | null
    buildCommand: string | null
    outputDirectory: string | null
    evidence: string[]
    blockers: PreviewBlocker[]
  }
  inspectedFiles: string[]
  warnings: string[]
}

export interface RepositoryAnalysisLoadOptions {
  signal?: AbortSignal
}

export type RepositoryAnalysisLoader = (
  target: RepositoryRevisionTarget,
  options?: RepositoryAnalysisLoadOptions,
) => Promise<RepositoryAnalysis>

export type BuildTargetAnalysis = Pick<
  RepositoryAnalysis,
  | "repository"
  | "technologies"
  | "packageManager"
  | "runtime"
  | "environment"
  | "environmentRequirements"
  | "preview"
  | "inspectedFiles"
  | "warnings"
> & {
  targetAnalyzerVersion: string
  target: PreviewTarget
}

export interface BuildTargetAnalysisLoadOptions {
  signal?: AbortSignal
}

export type BuildTargetAnalysisLoader = (
  repository: RepositoryMetadata,
  target: PreviewTarget,
  options?: BuildTargetAnalysisLoadOptions,
) => Promise<BuildTargetAnalysis>
