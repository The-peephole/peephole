import type { Framework, PackageManager } from "../../types/analysis"
import type { ParsedPackageJson } from "./packageJson"

export interface RuntimeDetection {
  installCommand: string | null
  devCommand: string | null
  buildCommand: string | null
  outputDirectory: string | null
  evidence: string[]
  warnings: string[]
}

export function detectRuntime(
  framework: Framework,
  packageManager: PackageManager,
  installCommand: string | null,
  packageJson: ParsedPackageJson | null,
  textFiles: Readonly<Record<string, string>>,
): RuntimeDetection {
  if (framework === "static") {
    return {
      installCommand: null,
      devCommand: null,
      buildCommand: null,
      outputDirectory: ".",
      evidence: ["Static root can be published without a package build"],
      warnings: [],
    }
  }

  const evidence: string[] = []
  const warnings: string[] = []
  const scripts = packageJson?.scripts ?? {}
  const devCommand = scripts.dev
    ? createScriptCommand(packageManager, "dev")
    : scripts.start
      ? createScriptCommand(packageManager, "start")
      : null
  const buildCommand = scripts.build
    ? createScriptCommand(packageManager, "build")
    : null

  if (devCommand) {
    evidence.push(`Development script detected: ${devCommand}`)
  }

  if (buildCommand) {
    evidence.push(`Build script detected: ${buildCommand}`)
  }

  let outputDirectory: string | null = null

  if (
    framework === "react-vite" ||
    framework === "vue-vite" ||
    framework === "svelte-vite"
  ) {
    outputDirectory = detectViteOutputDirectory(textFiles, warnings)

    if (outputDirectory) {
      evidence.push(`Static output directory resolved as ${outputDirectory}`)
    }
  }

  return {
    installCommand,
    devCommand,
    buildCommand,
    outputDirectory,
    evidence,
    warnings,
  }
}

function createScriptCommand(
  packageManager: PackageManager,
  script: string,
): string | null {
  switch (packageManager) {
    case "npm":
    case "pnpm":
    case "bun":
      return `${packageManager} run ${script}`
    case "yarn":
      return `yarn ${script}`
    default:
      return null
  }
}

function detectViteOutputDirectory(
  textFiles: Readonly<Record<string, string>>,
  warnings: string[],
): string | null {
  const config = Object.entries(textFiles).find(([path]) =>
    path.startsWith("vite.config."),
  )?.[1]

  if (!config) {
    return "dist"
  }

  const match = config.match(/\boutDir\s*:\s*["'`]([^"'`]+)["'`]/)

  if (!match?.[1]) {
    if (/\boutDir\s*:/.test(config)) {
      warnings.push("Vite outDir is dynamic and cannot be resolved safely.")
      return null
    }

    return "dist"
  }

  const path = match[1].replace(/^\.\//, "").replace(/\/$/, "")

  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").includes("..")
  ) {
    warnings.push("Vite outDir is not a safe repository-relative path.")
    return null
  }

  return path
}
