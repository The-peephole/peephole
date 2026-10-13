import { BACKEND_RUNTIME_CONTRACT_VERSION } from "../../types/backendRuntime"
import type { BackendRuntimePlan } from "../../types/backendRuntime"
import { PREVIEW_GENERATED_SECRET_NAMES } from "../../types/backendRuntimeSecrets"
import { BACKEND_RUNTIME_DATABASE_ENV_NAME } from "../../types/backendRuntimeDatabase"
import { isEligiblePreviewGeneratedSecretName } from "../backendSecrets/generatedSecretPolicy"
import { isEligibleUserEnvironmentName } from "../userEnvironment/userEnvironmentPolicy"
import { USER_ENVIRONMENT_LIMITS } from "../../types/userEnvironment"
import { validateRepositoryRef } from "./buildPlan"
import { isSafePreviewSourceRoot } from "./sourceRoot"

export class InvalidBackendRuntimePlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidBackendRuntimePlanError"
  }
}

const ALLOWED_INSTALL_ARGS = ["ci", "--no-audit", "--no-fund"] as const
const ENTRYPOINT_EXTENSION_PATTERN = /\.(js|mjs|cjs)$/
const SHELL_METACHARACTER_PATTERN = /[\s;&|`$(){}<>"'\\*?[\]!~]/
const MIN_INTERNAL_PORT = 1024
const MAX_INTERNAL_PORT = 65535

/**
 * The worker's own independent re-validation of a queued `BackendRuntimePlan`
 * -- deliberately does not trust that a plan reaching the queue is safe
 * merely because `BackendRuntimeControlPlane`/`GitHubBackendRuntimePlanResolver`
 * produced it (defense against a compromised or buggy queue/store
 * implementation, and the last check before anything actually executes).
 * Every executable field is checked against an exact allowlist -- this
 * function throws on a wildcard, an unrecognized adapter, a shell
 * metacharacter, or anything outside the narrow shape
 * `core/analyzer/backendRuntimeAdapter.ts` ever produces. Wholly independent
 * of `core/preview/buildAdapters.ts`'s `validateBuildPlan` -- backend-v1 is
 * never allowed to extend or reuse the static contract's validation.
 */
export function validateBackendRuntimePlan(
  value: BackendRuntimePlan,
): BackendRuntimePlan {
  if (!value || typeof value !== "object") {
    throw new InvalidBackendRuntimePlanError(
      "Backend runtime plan must be an object.",
    )
  }

  if (value.contractVersion !== BACKEND_RUNTIME_CONTRACT_VERSION) {
    throw new InvalidBackendRuntimePlanError(
      "Unsupported backend runtime contract version.",
    )
  }

  if (value.adapterId !== "express-node-npm-v1") {
    throw new InvalidBackendRuntimePlanError(
      "Unsupported backend runtime adapter.",
    )
  }

  try {
    validateRepositoryRef(value.repository)
  } catch (error) {
    throw new InvalidBackendRuntimePlanError(
      error instanceof Error
        ? error.message
        : "Backend runtime plan repository is invalid.",
    )
  }

  if (!isSafePreviewSourceRoot(value.sourceRoot)) {
    throw new InvalidBackendRuntimePlanError(
      "Backend runtime plan sourceRoot is unsafe.",
    )
  }

  if (value.packageManager !== "npm") {
    throw new InvalidBackendRuntimePlanError(
      "Only npm is supported for backend-v1.",
    )
  }

  if (
    !value.install ||
    value.install.command !== "npm" ||
    !Array.isArray(value.install.args) ||
    value.install.args.length !== ALLOWED_INSTALL_ARGS.length ||
    value.install.args.some((arg, index) => arg !== ALLOWED_INSTALL_ARGS[index])
  ) {
    throw new InvalidBackendRuntimePlanError(
      "Backend runtime install command is not the exact allowlisted npm ci invocation.",
    )
  }

  if (
    !value.start ||
    value.start.command !== "node" ||
    !Array.isArray(value.start.args) ||
    value.start.args.length !== 1 ||
    !isSafeExecutableEntrypoint(value.start.args[0])
  ) {
    throw new InvalidBackendRuntimePlanError(
      "Backend runtime start command is not a safe, direct node invocation.",
    )
  }

  if (
    !Number.isInteger(value.internalPort) ||
    value.internalPort < MIN_INTERNAL_PORT ||
    value.internalPort > MAX_INTERNAL_PORT
  ) {
    throw new InvalidBackendRuntimePlanError(
      "Backend runtime internal port is out of range.",
    )
  }

  validatePlatformEnvironment(value.platformEnvironment, value.internalPort)
  validateGeneratedSecretNames(value.generatedSecretNames)
  validateDatabaseRequirement(value.databaseRequirement)
  validateUserEnvironmentNames(value.userEnvironmentNames)

  return value
}

/** Names only; the same eligibility policy the adapter applied, re-checked
 * here so a queued plan can never smuggle a reserved, generated, database,
 * or client-public name into the user-configuration channel. */
function validateUserEnvironmentNames(
  value: BackendRuntimePlan["userEnvironmentNames"],
): void {
  if (!Array.isArray(value)) {
    throw new InvalidBackendRuntimePlanError(
      "Backend runtime user environment names must be an array.",
    )
  }
  if (value.length > USER_ENVIRONMENT_LIMITS.maxEntries) {
    throw new InvalidBackendRuntimePlanError(
      "Backend runtime user environment names exceed the fixed bound.",
    )
  }
  let previous: string | null = null
  for (const name of value) {
    if (typeof name !== "string" || !isEligibleUserEnvironmentName(name)) {
      throw new InvalidBackendRuntimePlanError(
        "Backend runtime user environment name is not eligible.",
      )
    }
    if (previous !== null && previous >= name) {
      throw new InvalidBackendRuntimePlanError(
        "Backend runtime user environment names must be sorted and unique.",
      )
    }
    previous = name
  }
}

function validateDatabaseRequirement(
  value: BackendRuntimePlan["databaseRequirement"],
): void {
  if (value === null) return

  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    value.name !== BACKEND_RUNTIME_DATABASE_ENV_NAME
  ) {
    throw new InvalidBackendRuntimePlanError(
      "Backend runtime database requirement must be null or the exact names-only DATABASE_URL contract.",
    )
  }
}

function validateGeneratedSecretNames(
  value: BackendRuntimePlan["generatedSecretNames"],
): void {
  if (!Array.isArray(value)) {
    throw new InvalidBackendRuntimePlanError(
      "Backend runtime generated secret names must be an array.",
    )
  }
  if (value.length > PREVIEW_GENERATED_SECRET_NAMES.length) {
    throw new InvalidBackendRuntimePlanError(
      "Backend runtime generated secret names exceed the fixed allowlist size.",
    )
  }

  const seen = new Set<string>()
  for (const name of value) {
    if (
      typeof name !== "string" ||
      !isEligiblePreviewGeneratedSecretName(name)
    ) {
      throw new InvalidBackendRuntimePlanError(
        "Backend runtime generated secret name is not allowlisted.",
      )
    }
    if (seen.has(name)) {
      throw new InvalidBackendRuntimePlanError(
        "Backend runtime generated secret names must not contain duplicates.",
      )
    }
    seen.add(name)
  }
}

function isSafeExecutableEntrypoint(entrypoint: unknown): entrypoint is string {
  if (typeof entrypoint !== "string" || entrypoint.length === 0) return false
  if (entrypoint.length > 512) return false
  if (entrypoint.startsWith("/")) return false
  if (
    entrypoint.split("/").some((segment) => segment === "" || segment === "..")
  ) {
    return false
  }
  if (SHELL_METACHARACTER_PATTERN.test(entrypoint)) return false
  return ENTRYPOINT_EXTENSION_PATTERN.test(entrypoint)
}

/**
 * `platformEnvironment` is never user- or repository-derived (see
 * `core/analyzer/backendRuntimeAdapter.ts`) -- HOST and NODE_ENV are always
 * exactly one fixed literal each, so this checks for that literal directly
 * rather than merely "a string", the tightest possible allowlist.
 */
function validatePlatformEnvironment(
  value: BackendRuntimePlan["platformEnvironment"],
  internalPort: number,
): void {
  if (!value || typeof value !== "object") {
    throw new InvalidBackendRuntimePlanError(
      "Backend runtime platform environment is invalid.",
    )
  }

  if (Object.keys(value).length !== 3) {
    throw new InvalidBackendRuntimePlanError(
      "Backend runtime platform environment must contain exactly PORT, HOST, and NODE_ENV.",
    )
  }

  if (value.PORT !== String(internalPort)) {
    throw new InvalidBackendRuntimePlanError(
      "Backend runtime PORT does not match its internal port.",
    )
  }

  if (value.HOST !== "0.0.0.0") {
    throw new InvalidBackendRuntimePlanError("Backend runtime HOST is invalid.")
  }

  if (value.NODE_ENV !== "production") {
    throw new InvalidBackendRuntimePlanError(
      "Backend runtime NODE_ENV is invalid.",
    )
  }
}
