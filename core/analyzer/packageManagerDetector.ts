import type { PackageManager, PreviewBlocker } from "../../types/analysis"
import type { ParsedPackageJson } from "./packageJson"

const LOCKFILE_MANAGERS = new Map<
  string,
  Exclude<PackageManager, "none" | "unknown">
>([
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
])

export interface PackageManagerDetection {
  packageManager: PackageManager
  installCommand: string | null
  evidence: string[]
  blockers: PreviewBlocker[]
}

export function detectPackageManager(
  packageJson: ParsedPackageJson | null,
  packageJsonPresent: boolean,
  presentPaths: readonly string[],
): PackageManagerDetection {
  if (!packageJsonPresent) {
    return {
      packageManager: "none",
      installCommand: null,
      evidence: ["No package manifest detected"],
      blockers: [],
    }
  }

  const lockManagers = Array.from(LOCKFILE_MANAGERS.entries())
    .filter(([path]) => presentPaths.includes(path))
    .map(([path, manager]) => ({ path, manager }))
  const distinctManagers = new Set(lockManagers.map(({ manager }) => manager))
  const declared = parseDeclaredPackageManager(packageJson?.packageManager)
  const evidence = lockManagers.map(
    ({ path, manager }) => `${path} selects ${manager}`,
  )
  const blockers: PreviewBlocker[] = []

  if (packageJson?.packageManager) {
    evidence.push(`packageManager declares ${packageJson.packageManager}`)
  }

  if (distinctManagers.size > 1) {
    blockers.push({
      code: "CONFLICTING_LOCKFILES",
      message: "Multiple package-manager lockfiles were detected.",
    })

    return {
      packageManager: "unknown",
      installCommand: null,
      evidence,
      blockers,
    }
  }

  const lockManager = lockManagers[0]?.manager ?? null

  if (declared && lockManager && declared !== lockManager) {
    blockers.push({
      code: "CONFLICTING_LOCKFILES",
      message: `packageManager declares ${declared}, but the lockfile selects ${lockManager}.`,
    })

    return {
      packageManager: "unknown",
      installCommand: null,
      evidence,
      blockers,
    }
  }

  const packageManager = declared ?? lockManager ?? "unknown"

  if (packageManager === "unknown" || !lockManager) {
    blockers.push({
      code: "UNKNOWN_PACKAGE_MANAGER",
      message:
        packageManager === "unknown"
          ? "A deterministic package manager could not be selected."
          : `A ${packageManager} lockfile is required for a frozen install.`,
    })
  }

  return {
    packageManager,
    installCommand:
      packageManager === "unknown" || !lockManager
        ? null
        : getInstallCommand(packageManager, packageJson?.packageManager),
    evidence,
    blockers,
  }
}

function parseDeclaredPackageManager(
  value: string | null | undefined,
): Exclude<PackageManager, "none" | "unknown"> | null {
  const name = value?.split("@")[0]

  return name === "npm" || name === "pnpm" || name === "yarn" || name === "bun"
    ? name
    : null
}

function getInstallCommand(
  packageManager: Exclude<PackageManager, "none" | "unknown">,
  declaration: string | null | undefined,
): string {
  switch (packageManager) {
    case "npm":
      return "npm ci"
    case "pnpm":
      return "pnpm install --frozen-lockfile"
    case "bun":
      return "bun install --frozen-lockfile"
    case "yarn": {
      const major = Number(declaration?.match(/^yarn@(\d+)/)?.[1])
      return Number.isFinite(major) && major >= 2
        ? "yarn install --immutable"
        : "yarn install --frozen-lockfile"
    }
  }
}
