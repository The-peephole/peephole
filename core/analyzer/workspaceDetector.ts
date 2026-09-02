import type { ParsedPackageJson } from "./packageJson"

export interface WorkspaceDetection {
  monorepo: boolean
  ambiguous: boolean
  evidence: string[]
}

export function detectWorkspace(
  packageJson: ParsedPackageJson | null,
  presentPaths: readonly string[],
): WorkspaceDetection {
  const evidence: string[] = []

  if (packageJson?.workspaces !== undefined) {
    evidence.push("package.json workspaces detected")
  }

  const workspaceFiles = [
    "pnpm-workspace.yaml",
    "turbo.json",
    "nx.json",
    "lerna.json",
  ].filter((path) => presentPaths.includes(path))

  evidence.push(...workspaceFiles.map((path) => `${path} detected`))

  const monorepo = evidence.length > 0

  return {
    monorepo,
    ambiguous: monorepo,
    evidence,
  }
}
