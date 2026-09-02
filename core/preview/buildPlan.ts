import {
  PREVIEW_CONTRACT_VERSION,
  type RepositoryAnalysis,
} from "../../types/analysis"
import type {
  BuildPlan,
  PreviewRepositoryRef,
  RunnablePackageManager,
} from "../../types/preview"

const COMMIT_SHA_PATTERN = /^[a-f\d]{40}$/i
const OWNER_PATTERN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i
const REPOSITORY_PATTERN = /^[a-z\d_.-]+$/i

const INSTALL_COMMANDS: Record<
  RunnablePackageManager,
  ReadonlyArray<string | null>
> = {
  npm: ["npm ci"],
  pnpm: ["pnpm install --frozen-lockfile"],
  yarn: ["yarn install --frozen-lockfile", "yarn install --immutable"],
  bun: ["bun install --frozen-lockfile"],
  none: [null],
}

const BUILD_COMMANDS: Record<
  RunnablePackageManager,
  ReadonlyArray<string | null>
> = {
  npm: ["npm run build"],
  pnpm: ["pnpm run build"],
  yarn: ["yarn build"],
  bun: ["bun run build"],
  none: [null],
}

export class InvalidBuildPlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidBuildPlanError"
  }
}

export function createBuildPlanFromAnalysis(
  analysis: RepositoryAnalysis,
): BuildPlan | null {
  const framework = analysis.technologies.framework
  const isSupportedFramework =
    framework === "static" ||
    framework === "react-vite" ||
    framework === "vue-vite" ||
    framework === "svelte-vite"

  if (
    !isSupportedFramework ||
    analysis.preview.blockers.length > 0 ||
    analysis.preview.contractVersion !== PREVIEW_CONTRACT_VERSION ||
    analysis.preview.packageManager === "unknown" ||
    !analysis.preview.outputDirectory
  ) {
    return null
  }

  return validateBuildPlan({
    contractVersion: analysis.preview.contractVersion,
    repository: {
      repositoryId: analysis.repository.repositoryId,
      owner: analysis.repository.owner,
      name: analysis.repository.repo,
      commitSha: analysis.repository.commitSha,
    },
    sourceRoot: ".",
    packageManager: analysis.preview.packageManager,
    installCommand: analysis.preview.installCommand,
    buildCommand: analysis.preview.buildCommand,
    outputDirectory: analysis.preview.outputDirectory,
  })
}

export function validateBuildPlan(value: BuildPlan): BuildPlan {
  validateRepositoryRef(value.repository)

  if (value.contractVersion !== PREVIEW_CONTRACT_VERSION) {
    throw new InvalidBuildPlanError("Unsupported preview contract version.")
  }

  if (value.sourceRoot !== ".") {
    throw new InvalidBuildPlanError("Only the repository root is supported.")
  }

  const allowedInstallCommands = INSTALL_COMMANDS[value.packageManager]
  const allowedBuildCommands = BUILD_COMMANDS[value.packageManager]

  if (!allowedInstallCommands?.includes(value.installCommand)) {
    throw new InvalidBuildPlanError(
      "The install command does not match the selected package manager.",
    )
  }

  if (!allowedBuildCommands?.includes(value.buildCommand)) {
    throw new InvalidBuildPlanError(
      "The build command does not match the selected package manager.",
    )
  }

  if (value.packageManager === "none" && value.outputDirectory !== ".") {
    throw new InvalidBuildPlanError(
      "Package-free static previews must publish the repository root.",
    )
  }

  if (!isSafeRelativeOutputPath(value.outputDirectory)) {
    throw new InvalidBuildPlanError(
      "The output directory is not a safe repository-relative path.",
    )
  }

  return structuredClone(value)
}

export function validateRepositoryRef(repository: PreviewRepositoryRef): void {
  if (
    !Number.isSafeInteger(repository.repositoryId) ||
    repository.repositoryId <= 0
  ) {
    throw new InvalidBuildPlanError("Repository id must be a positive integer.")
  }

  if (!OWNER_PATTERN.test(repository.owner)) {
    throw new InvalidBuildPlanError("Repository owner is invalid.")
  }

  if (!REPOSITORY_PATTERN.test(repository.name)) {
    throw new InvalidBuildPlanError("Repository name is invalid.")
  }

  if (!COMMIT_SHA_PATTERN.test(repository.commitSha)) {
    throw new InvalidBuildPlanError(
      "Commit SHA must be immutable and complete.",
    )
  }
}

export async function createBuildCacheKey(
  plan: BuildPlan,
  runnerVersion: string,
): Promise<string> {
  const canonical = JSON.stringify({
    repositoryId: plan.repository.repositoryId,
    commitSha: plan.repository.commitSha.toLowerCase(),
    contractVersion: plan.contractVersion,
    runnerVersion,
    sourceRoot: plan.sourceRoot,
    packageManager: plan.packageManager,
    installCommand: plan.installCommand,
    buildCommand: plan.buildCommand,
    outputDirectory: plan.outputDirectory,
  })
  const bytes = new TextEncoder().encode(canonical)
  const digest = await crypto.subtle.digest("SHA-256", bytes)

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")
}

function isSafeRelativeOutputPath(path: string): boolean {
  if (path === ".") {
    return true
  }

  return (
    path.length > 0 &&
    path.length <= 128 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((segment) => segment === "" || segment === "..")
  )
}
