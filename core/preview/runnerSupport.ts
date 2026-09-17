import type {
  Framework,
  PackageManager,
  PreviewBlocker,
} from "../../types/analysis"
import { isBuildAdapterAvailable } from "./buildAdapters"

/** One release capability table shared by analysis, the UI, and the API. */
export function isImplementedRunnerTarget(
  framework: Framework,
  packageManager: PackageManager,
  presentPaths: readonly string[],
): boolean {
  return isBuildAdapterAvailable({
    technologies: { framework },
    packageManager,
    inspectedFiles: presentPaths,
  })
}

export function runnerSupportBlocker(
  framework: Framework,
  packageManager: PackageManager,
  presentPaths: readonly string[],
): PreviewBlocker | null {
  const implemented = isImplementedRunnerTarget(
    framework,
    packageManager,
    presentPaths,
  )

  if (
    !implemented &&
    (framework === "vue-vite" || framework === "svelte-vite")
  ) {
    return {
      code: "RUNNER_TARGET_UNAVAILABLE",
      message:
        "This Vite framework is recognized, but preview builds currently support React with npm only.",
    }
  }
  if (
    !implemented &&
    framework === "react-vite" &&
    packageManager !== "unknown"
  ) {
    if (
      packageManager === "npm" &&
      !presentPaths.includes("package-lock.json")
    ) {
      return {
        code: "RUNNER_TARGET_UNAVAILABLE",
        message:
          "Preview builds currently require a root package-lock.json file for npm ci.",
      }
    }

    return {
      code: "RUNNER_TARGET_UNAVAILABLE",
      message: `The ${packageManager} package manager is recognized, but preview builds currently require npm.`,
    }
  }
  return null
}
