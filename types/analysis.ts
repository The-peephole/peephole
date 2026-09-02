import type { RepositoryIdentity, RepositoryMetadata } from "./repository"

export const ANALYZER_VERSION = "0.1.0"
export const PREVIEW_CONTRACT_VERSION = "static-v1"

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
  deployment: {
    status: "confirmed" | "configured" | "unknown"
    provider: "homepage" | "vercel" | "netlify" | null
    url: string | null
    evidence: string[]
  }
  workspace: {
    monorepo: boolean
    ambiguous: boolean
    evidence: string[]
  }
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
  repository: RepositoryIdentity,
  options?: RepositoryAnalysisLoadOptions,
) => Promise<RepositoryAnalysis>
