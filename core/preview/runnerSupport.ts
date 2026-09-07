import type {
  Framework,
  PackageManager,
  PreviewBlocker,
} from "../../types/analysis"

/** One release capability table shared by analysis, the UI, and the API. */
export function isImplementedRunnerTarget(
  framework: Framework,
  packageManager: PackageManager,
): boolean {
  return (
    (framework === "static" && packageManager === "none") ||
    (framework === "react-vite" && packageManager === "npm")
  )
}

export function runnerSupportBlocker(
  framework: Framework,
  packageManager: PackageManager,
  presentPaths: readonly string[],
): PreviewBlocker | null {
  if (framework === "vue-vite" || framework === "svelte-vite") {
    return {
      code: "RUNNER_TARGET_UNAVAILABLE",
      message:
        "This Vite framework is recognized, but preview builds currently support React with npm only.",
    }
  }
  if (framework === "react-vite" && packageManager !== "unknown") {
    if (!isImplementedRunnerTarget(framework, packageManager)) {
      return {
        code: "RUNNER_TARGET_UNAVAILABLE",
        message: `The ${packageManager} package manager is recognized, but preview builds currently require npm.`,
      }
    }
    if (!presentPaths.includes("package-lock.json")) {
      return {
        code: "RUNNER_TARGET_UNAVAILABLE",
        message:
          "Preview builds currently require a root package-lock.json file for npm ci.",
      }
    }
  }
  return null
}
