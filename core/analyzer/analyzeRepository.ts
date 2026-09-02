import {
  ANALYZER_VERSION,
  PREVIEW_CONTRACT_VERSION,
  type PreviewBlocker,
  type RepositoryAnalysis,
} from "../../types/analysis"
import type { RepositoryMetadata } from "../../types/repository"
import type { RepositoryFileSnapshot } from "../github/knownFiles"
import { detectDeployment } from "./deploymentDetector"
import { detectEnvironment } from "./environmentDetector"
import { detectFramework } from "./frameworkDetector"
import { detectPackageManager } from "./packageManagerDetector"
import { getAllDependencies, parsePackageJson } from "./packageJson"
import { detectRuntime } from "./runtimeDetector"
import { detectWorkspace } from "./workspaceDetector"

const SERVER_DEPENDENCIES = new Set([
  "@nestjs/core",
  "@prisma/client",
  "better-sqlite3",
  "express",
  "fastify",
  "hapi",
  "koa",
  "mongoose",
  "mysql2",
  "pg",
  "prisma",
])

const HOSTED_BACKEND_DEPENDENCIES = new Set([
  "@supabase/supabase-js",
  "aws-amplify",
  "firebase",
])

export function analyzeRepository(
  repository: RepositoryMetadata,
  files: RepositoryFileSnapshot,
): RepositoryAnalysis {
  const packageJsonPresent = files.presentPaths.includes("package.json")
  const packageJsonResult = parsePackageJson(files.textFiles["package.json"])
  const packageJson = packageJsonResult.value
  const framework = detectFramework(
    packageJson,
    packageJsonPresent,
    files.presentPaths,
  )
  const packageManager = detectPackageManager(
    packageJson,
    packageJsonPresent,
    files.presentPaths,
  )
  const runtime = detectRuntime(
    framework.framework,
    packageManager.packageManager,
    packageManager.installCommand,
    packageJson,
    files.textFiles,
  )
  const environment = detectEnvironment(files.presentPaths, files.textFiles)
  const deployment = detectDeployment(repository, files.presentPaths)
  const workspace = detectWorkspace(packageJson, files.presentPaths)
  const blockers: PreviewBlocker[] = [...packageManager.blockers]
  const warnings = [...files.warnings, ...runtime.warnings]

  if (packageJsonResult.error) {
    blockers.push({
      code: "MALFORMED_PACKAGE_JSON",
      message: packageJsonResult.error,
    })
  }

  if (packageJsonPresent && files.textFiles["package.json"] === undefined) {
    blockers.push({
      code: "ANALYSIS_INCOMPLETE",
      message: "package.json could not be inspected within analysis limits.",
    })
  }

  if (!files.complete) {
    blockers.push({
      code: "ANALYSIS_INCOMPLETE",
      message: "The repository root listing is incomplete.",
    })
  }

  const unreadEnvironmentTemplate = files.presentPaths.find(
    (path) => path.startsWith(".env") && files.textFiles[path] === undefined,
  )

  if (unreadEnvironmentTemplate) {
    blockers.push({
      code: "ANALYSIS_INCOMPLETE",
      message: `${unreadEnvironmentTemplate} could not be inspected within analysis limits.`,
    })
  }

  switch (framework.framework) {
    case "wxt":
      blockers.push({
        code: "UNSUPPORTED_FRAMEWORK",
        message:
          "WXT browser extensions require browser extension APIs and are outside the static v0.1 preview contract.",
      })
      break
    case "next":
      blockers.push({
        code: "PERSISTENT_SERVER_REQUIRED",
        message:
          "Next.js server execution is outside the static v0.1 contract.",
      })
      break
    case "react":
      blockers.push({
        code: "UNSUPPORTED_FRAMEWORK",
        message: "React without a recognized root Vite setup is unsupported.",
      })
      break
    case "unknown":
      blockers.push({
        code: "UNSUPPORTED_FRAMEWORK",
        message: "No supported static or root Vite application was detected.",
      })
      break
  }

  if (isViteFramework(framework.framework)) {
    if (!runtime.buildCommand) {
      blockers.push({
        code: "MISSING_BUILD_COMMAND",
        message: "A package.json build script is required for Vite preview.",
      })
    }

    if (!runtime.outputDirectory) {
      blockers.push({
        code: "UNKNOWN_OUTPUT_DIRECTORY",
        message: "A safe static output directory could not be resolved.",
      })
    }
  }

  if (environment.secretLikeVariables.length > 0) {
    blockers.push({
      code: "SECRET_ENV_REQUIRED",
      message: `Secret-like environment variables are declared: ${environment.secretLikeVariables.join(", ")}.`,
    })
  }

  if (workspace.ambiguous) {
    blockers.push({
      code: "AMBIGUOUS_WORKSPACE",
      message: "Workspace application selection is outside the v0.1 contract.",
    })
  }

  const externalServiceEvidence = detectExternalServices(
    packageJson,
    environment.variables,
  )
  blockers.push(...externalServiceEvidence.blockers)
  warnings.push(...externalServiceEvidence.warnings)

  const uniqueBlockers = deduplicateBlockers(blockers)
  const previewEvidence = [
    ...framework.evidence,
    ...packageManager.evidence,
    ...runtime.evidence,
  ]
  const mode =
    deployment.status === "confirmed"
      ? "existing-deployment"
      : uniqueBlockers.length === 0
        ? "native-static-build"
        : "unsupported"

  return {
    repository,
    analyzerVersion: ANALYZER_VERSION,
    technologies: framework,
    packageManager: packageManager.packageManager,
    runtime,
    environment,
    deployment,
    workspace,
    preview: {
      contractVersion: PREVIEW_CONTRACT_VERSION,
      mode,
      packageManager: packageManager.packageManager,
      installCommand: runtime.installCommand,
      buildCommand: runtime.buildCommand,
      outputDirectory: runtime.outputDirectory,
      evidence: Array.from(new Set(previewEvidence)),
      blockers: uniqueBlockers,
    },
    inspectedFiles: files.presentPaths,
    warnings: Array.from(new Set(warnings)),
  }
}

function detectExternalServices(
  packageJson: ReturnType<typeof parsePackageJson>["value"],
  environmentVariables: readonly string[],
): { blockers: PreviewBlocker[]; warnings: string[] } {
  const dependencies = getAllDependencies(packageJson)
  const dependencyNames = Object.keys(dependencies)
  const serverDependencies = dependencyNames.filter((name) =>
    SERVER_DEPENDENCIES.has(name),
  )
  const hostedBackends = dependencyNames.filter((name) =>
    HOSTED_BACKEND_DEPENDENCIES.has(name),
  )
  const blockers: PreviewBlocker[] = []
  const warnings: string[] = []

  if (serverDependencies.length > 0) {
    blockers.push({
      code: "BACKEND_REQUIRED",
      message: `Server or database dependencies detected: ${serverDependencies.join(", ")}.`,
    })
  }

  if (hostedBackends.length > 0) {
    warnings.push(
      `Hosted backend clients detected: ${hostedBackends.join(", ")}.`,
    )
  }

  const apiVariables = environmentVariables.filter((name) =>
    /(?:API_URL|BASE_URL|SUPABASE_URL|FIREBASE)/i.test(name),
  )

  if (apiVariables.length > 0) {
    warnings.push(
      `External service variables detected: ${apiVariables.join(", ")}.`,
    )
  }

  return { blockers, warnings }
}

function isViteFramework(framework: string): boolean {
  return (
    framework === "react-vite" ||
    framework === "vue-vite" ||
    framework === "svelte-vite"
  )
}

function deduplicateBlockers(
  blockers: readonly PreviewBlocker[],
): PreviewBlocker[] {
  const seen = new Set<string>()

  return blockers.filter((blocker) => {
    const key = `${blocker.code}:${blocker.message}`

    if (seen.has(key)) {
      return false
    }

    seen.add(key)
    return true
  })
}
