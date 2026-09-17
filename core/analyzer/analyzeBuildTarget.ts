import {
  PREVIEW_CONTRACT_VERSION,
  TARGET_ANALYZER_VERSION,
  type BuildTargetAnalysis,
  type PreviewBlocker,
} from "../../types/analysis"
import type { RepositoryMetadata } from "../../types/repository"
import type { PreviewTarget } from "../../types/target"
import type { RepositoryFileSnapshot } from "../github/knownFiles"
import { runnerSupportBlocker } from "../preview/runnerSupport"
import { detectEnvironment } from "./environmentDetector"
import { detectFramework } from "./frameworkDetector"
import { detectPackageManager } from "./packageManagerDetector"
import { getAllDependencies, parsePackageJson } from "./packageJson"
import { detectRuntime } from "./runtimeDetector"

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

export function analyzeBuildTarget(
  repository: RepositoryMetadata,
  target: PreviewTarget,
  files: RepositoryFileSnapshot,
  contractVersion = PREVIEW_CONTRACT_VERSION,
): BuildTargetAnalysis {
  const packageJsonPresent = files.presentPaths.includes("package.json")
  const packageJsonResult = parsePackageJson(files.textFiles["package.json"])
  const packageJson = packageJsonResult.value
  const technologies = detectFramework(
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
    technologies.framework,
    packageManager.packageManager,
    packageManager.installCommand,
    packageJson,
    files.textFiles,
  )
  const environment = detectEnvironment(files.presentPaths, files.textFiles)
  const blockers: PreviewBlocker[] = [...packageManager.blockers]
  const runnerBlocker = runnerSupportBlocker(
    technologies.framework,
    packageManager.packageManager,
    files.presentPaths,
  )
  if (runnerBlocker) blockers.push(runnerBlocker)
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
      message: "The selected preview target listing is incomplete.",
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

  addFrameworkBlockers(technologies.framework, blockers)

  if (isViteFramework(technologies.framework)) {
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

  if (
    target.sourceRoot !== "." &&
    technologies.framework === "react-vite" &&
    !files.presentPaths.includes("package-lock.json")
  ) {
    blockers.push({
      code: "RUNNER_TARGET_UNAVAILABLE",
      message:
        "Independent nested npm targets require package-lock.json inside the selected target; shared-root workspace execution is not supported yet.",
    })
  }

  if (environment.secretLikeVariables.length > 0) {
    blockers.push({
      code: "SECRET_ENV_REQUIRED",
      message: `Secret-like environment variables are declared: ${environment.secretLikeVariables.join(", ")}.`,
    })
  }

  const externalServices = detectExternalServices(
    packageJson,
    environment.variables,
  )
  blockers.push(...externalServices.blockers)
  warnings.push(...externalServices.warnings)

  const uniqueBlockers = deduplicateBlockers(blockers)

  return {
    repository,
    targetAnalyzerVersion: TARGET_ANALYZER_VERSION,
    target,
    technologies,
    packageManager: packageManager.packageManager,
    runtime,
    environment,
    preview: {
      contractVersion,
      mode: uniqueBlockers.length === 0 ? "native-static-build" : "unsupported",
      packageManager: packageManager.packageManager,
      installCommand: runtime.installCommand,
      buildCommand: runtime.buildCommand,
      outputDirectory: runtime.outputDirectory,
      evidence: Array.from(
        new Set([
          ...technologies.evidence,
          ...packageManager.evidence,
          ...runtime.evidence,
        ]),
      ),
      blockers: uniqueBlockers,
    },
    inspectedFiles: files.presentPaths,
    warnings: Array.from(new Set(warnings)),
  }
}

function addFrameworkBlockers(
  framework: BuildTargetAnalysis["technologies"]["framework"],
  blockers: PreviewBlocker[],
): void {
  switch (framework) {
    case "wxt":
      blockers.push({
        code: "UNSUPPORTED_FRAMEWORK",
        message:
          "WXT browser extensions require browser extension APIs and are outside the static preview contract.",
      })
      break
    case "next":
      blockers.push({
        code: "PERSISTENT_SERVER_REQUIRED",
        message: "Next.js server execution is outside the static contract.",
      })
      break
    case "react":
      blockers.push({
        code: "UNSUPPORTED_FRAMEWORK",
        message:
          "React without a recognized target-local Vite setup is unsupported.",
      })
      break
    case "unknown":
      blockers.push({
        code: "UNSUPPORTED_FRAMEWORK",
        message:
          "No supported static or Vite application was detected in this target.",
      })
      break
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

export function deduplicateBlockers(
  blockers: readonly PreviewBlocker[],
): PreviewBlocker[] {
  const seen = new Set<string>()

  return blockers.filter((blocker) => {
    const key = `${blocker.code}:${blocker.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
