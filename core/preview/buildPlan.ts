import {
  LEGACY_PREVIEW_CONTRACT_VERSION,
  PREVIEW_CONTRACT_VERSION,
} from "../../types/analysis"
import type { BuildPlan, PreviewRepositoryRef } from "../../types/preview"
import { isSafePreviewSourceRoot } from "./sourceRoot"

const COMMIT_SHA_PATTERN = /^[a-f\d]{40}$/i
const OWNER_PATTERN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i
const REPOSITORY_PATTERN = /^[a-z\d_.-]+$/i

export class InvalidBuildPlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidBuildPlanError"
  }
}

/** Validates the wire shape and security-sensitive paths, not runner support. */
export function validateBuildPlanShape(value: BuildPlan): BuildPlan {
  if (!value || typeof value !== "object") {
    throw new InvalidBuildPlanError("Build plan must be an object.")
  }

  validateRepositoryRef(value.repository)

  if (!isSupportedPreviewContractVersion(value.contractVersion)) {
    throw new InvalidBuildPlanError("Unsupported preview contract version.")
  }

  if (
    !isSafePreviewSourceRoot(value.sourceRoot) ||
    (value.contractVersion === LEGACY_PREVIEW_CONTRACT_VERSION &&
      value.sourceRoot !== ".")
  ) {
    throw new InvalidBuildPlanError(
      value.contractVersion === LEGACY_PREVIEW_CONTRACT_VERSION
        ? "Only the repository root is supported by static-v1."
        : "The preview source root is invalid for this contract version.",
    )
  }

  if (!["npm", "pnpm", "yarn", "bun", "none"].includes(value.packageManager)) {
    throw new InvalidBuildPlanError("Build plan package manager is invalid.")
  }

  if (
    (typeof value.installCommand !== "string" &&
      value.installCommand !== null) ||
    (typeof value.buildCommand !== "string" && value.buildCommand !== null)
  ) {
    throw new InvalidBuildPlanError("Build plan commands are invalid.")
  }

  if (typeof value.outputDirectory !== "string") {
    throw new InvalidBuildPlanError("Build plan output directory is invalid.")
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
    !repository ||
    typeof repository !== "object" ||
    !Number.isSafeInteger(repository.repositoryId) ||
    repository.repositoryId <= 0
  ) {
    throw new InvalidBuildPlanError("Repository id must be a positive integer.")
  }

  if (
    typeof repository.owner !== "string" ||
    !OWNER_PATTERN.test(repository.owner)
  ) {
    throw new InvalidBuildPlanError("Repository owner is invalid.")
  }

  if (
    typeof repository.name !== "string" ||
    !REPOSITORY_PATTERN.test(repository.name)
  ) {
    throw new InvalidBuildPlanError("Repository name is invalid.")
  }

  if (
    typeof repository.commitSha !== "string" ||
    !COMMIT_SHA_PATTERN.test(repository.commitSha)
  ) {
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

export function isSupportedPreviewContractVersion(value: string): boolean {
  return (
    value === LEGACY_PREVIEW_CONTRACT_VERSION ||
    value === PREVIEW_CONTRACT_VERSION
  )
}

export function isSafeRelativeOutputPath(path: string): boolean {
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
