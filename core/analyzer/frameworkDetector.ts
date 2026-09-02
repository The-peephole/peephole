import type { Framework } from "../../types/analysis"
import { getAllDependencies, type ParsedPackageJson } from "./packageJson"

export interface FrameworkDetection {
  framework: Framework
  typescript: boolean
  evidence: string[]
}

export function detectFramework(
  packageJson: ParsedPackageJson | null,
  packageJsonPresent: boolean,
  presentPaths: readonly string[],
): FrameworkDetection {
  const dependencies = getAllDependencies(packageJson)
  const hasViteConfig = presentPaths.some((path) =>
    path.startsWith("vite.config."),
  )
  const hasVite = "vite" in dependencies || hasViteConfig
  const hasReact = "react" in dependencies
  const hasVue = "vue" in dependencies
  const hasSvelte = "svelte" in dependencies
  const hasSvelteVitePlugin = "@sveltejs/vite-plugin-svelte" in dependencies
  const hasWxt = "wxt" in dependencies
  const hasNext = "next" in dependencies
  const evidence: string[] = []
  let framework: Framework = "unknown"

  if (hasWxt) {
    framework = "wxt"
    evidence.push("wxt dependency detected")
  } else if (hasNext) {
    framework = "next"
    evidence.push("next dependency detected")
  } else if (hasVite && hasReact) {
    framework = "react-vite"
    evidence.push("vite and react dependencies detected")
  } else if (hasVite && hasVue) {
    framework = "vue-vite"
    evidence.push("vite and vue dependencies detected")
  } else if (hasVite && hasSvelte && hasSvelteVitePlugin) {
    framework = "svelte-vite"
    evidence.push("vite, svelte, and the Svelte Vite plugin detected")
  } else if (hasReact) {
    framework = "react"
    evidence.push("react dependency detected without a supported Vite setup")
  } else if (!packageJsonPresent && presentPaths.includes("index.html")) {
    framework = "static"
    evidence.push("root index.html detected without package.json")
  }

  if (hasViteConfig) {
    evidence.push("root Vite configuration detected")
  }

  const typescript =
    "typescript" in dependencies ||
    presentPaths.includes("tsconfig.json") ||
    presentPaths.some((path) => /\.config\.(?:ts|mts)$/.test(path))

  if (typescript) {
    evidence.push("TypeScript configuration or dependency detected")
  }

  return { framework, typescript, evidence }
}
