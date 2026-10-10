import type { BackendCandidate } from "../../types/backend"
import type {
  BackendExecutionSupport,
  BackendRuntimeAdapterId,
  BackendRuntimePlan,
} from "../../types/backendRuntime"
import { BACKEND_RUNTIME_CONTRACT_VERSION } from "../../types/backendRuntime"
import type { PreviewRepositoryRef } from "../../types/preview"
import type { PreviewGeneratedSecretName } from "../../types/backendRuntimeSecrets"
import type { EnvironmentRequirement } from "../../types/environment"
import { BACKEND_RUNTIME_DATABASE_ENV_NAME } from "../../types/backendRuntimeDatabase"
import { isEligiblePreviewGeneratedSecretName } from "../backendSecrets/generatedSecretPolicy"
import { isSafePreviewSourceRoot } from "../preview/sourceRoot"
import {
  isUserConfigurableRequirement,
  resolveUserEnvironmentNames,
} from "../userEnvironment/userEnvironmentPolicy"
import { isNpmBackendPackageManagerDeclaration } from "./backendPackageManager"

/**
 * `express-node-npm-v1` is the only implemented backend-v1 adapter. It is
 * DETECTION-TO-EXECUTION only for a very narrow shape -- see
 * `docs/PREVIEW_RUNTIME.md`. A candidate detected by M7
 * (`core/analyzer/backendDetector.ts`) with a *different* framework, a
 * unsupported database shape, a missing lockfile, an unresolved entrypoint,
 * or any environment requirement outside fixed `PORT`/`HOST`/`NODE_ENV`, the
 * canonical server-only generated-secret policy, and the exact names-only M11
 * `pg` + `DATABASE_URL` capability is never eligible for a runtime plan --
 * "Backend detected" and "Execution supported" are always evaluated
 * separately. Server-side plan eligibility and current standalone-client
 * execution support are separate decisions: the trusted FullStack path may
 * resolve an exact database plan that the public standalone UI must not
 * advertise as runnable. This module never trusts anything client-provided:
 * every caller must pass a `BackendCandidate` it independently derived
 * (client) or independently re-derived at the exact commit (server) --
 * this module has no knowledge of *how* the candidate was obtained.
 */

/** Fixed for every job: isolation comes from the per-job network namespace,
 * never from port uniqueness, so there is nothing to allocate here. */
const INTERNAL_PORT = 3000

const ONLY_ALLOWED_ENTRYPOINT_EXTENSIONS = new Set(["js", "mjs", "cjs"])

export function resolveBackendExecutionSupport(
  candidate: BackendCandidate,
): BackendExecutionSupport {
  const rejection = findUnsupportedPlanReason(candidate)

  if (rejection) {
    return { supported: false, adapterId: null, evidence: [rejection] }
  }

  if (
    (resolveUserEnvironmentNames(candidate.environmentRequirements) ?? [])
      .length > 0
  ) {
    return {
      supported: false,
      adapterId: null,
      evidence: [
        "User-provided configuration is accepted only through trusted full-stack preview admission; standalone backend-v1 execution is not available.",
      ],
    }
  }

  if (candidate.databaseDependencies.length > 0) {
    return {
      supported: false,
      adapterId: null,
      evidence: [
        "The pg + server-side DATABASE_URL backend shape is recognized, but temporary database execution requires trusted FullStack orchestration; standalone backend-v1 execution is not available.",
      ],
    }
  }

  return {
    supported: true,
    adapterId: "express-node-npm-v1",
    evidence: [
      "express dependency, package-lock.json, a safe Node entrypoint, and only platform-owned or canonical generated-secret environment requirements were found",
    ],
  }
}

/**
 * Independently re-derives the plan a job would run with -- never accepts
 * one from a client. Returns null for anything not covered by
 * `express-node-npm-v1`; callers must treat null as "unsupported", not
 * retry with a guessed command.
 */
export function resolveBackendRuntimePlan(
  repository: PreviewRepositoryRef,
  candidate: BackendCandidate,
): BackendRuntimePlan | null {
  if (findUnsupportedPlanReason(candidate)) return null

  // findUnsupportedPlanReason already proved these are non-null/safe.
  const entrypoint = candidate.entrypoint!

  const adapterId: BackendRuntimeAdapterId = "express-node-npm-v1"
  const generatedSecretNames = Array.from(
    new Set(
      candidate.environmentRequirements.flatMap(
        (requirement): PreviewGeneratedSecretName[] =>
          isSupportedGeneratedSecretRequirement(requirement)
            ? [requirement.name]
            : [],
      ),
    ),
  ).sort()

  return {
    contractVersion: BACKEND_RUNTIME_CONTRACT_VERSION,
    repository,
    sourceRoot: candidate.sourceRoot,
    adapterId,
    packageManager: "npm",
    install: { command: "npm", args: ["ci", "--no-audit", "--no-fund"] },
    start: { command: "node", args: [entrypoint] },
    internalPort: INTERNAL_PORT,
    platformEnvironment: {
      PORT: String(INTERNAL_PORT),
      HOST: "0.0.0.0",
      NODE_ENV: "production",
    },
    generatedSecretNames,
    databaseRequirement:
      candidate.databaseDependencies.length === 1
        ? { name: BACKEND_RUNTIME_DATABASE_ENV_NAME }
        : null,
    // findUnsupportedPlanReason already proved the bound holds.
    userEnvironmentNames:
      resolveUserEnvironmentNames(candidate.environmentRequirements) ?? [],
  }
}

function findUnsupportedPlanReason(candidate: BackendCandidate): string | null {
  if (candidate.framework !== "express") {
    return `${candidate.framework} execution is not supported yet.`
  }

  if (!isSafePreviewSourceRoot(candidate.sourceRoot)) {
    return "The backend source root is not safe to execute."
  }

  if (!candidate.packageLockPresent) {
    return "package-lock.json is required for backend-v1 execution."
  }

  if (!isNpmBackendPackageManagerDeclaration(candidate.packageManager)) {
    return "Only npm may be declared for backend-v1 execution."
  }

  if (!isSafeVerifiableEntrypoint(candidate.entrypoint)) {
    return "A safe Node entrypoint could not be resolved."
  }

  const databaseRequirements = candidate.environmentRequirements.filter(
    (requirement) => requirement.requirementKind === "database-requirement",
  )
  const hasDatabaseDependency = candidate.databaseDependencies.length > 0
  const hasDatabaseRequirement = databaseRequirements.length > 0

  if (hasDatabaseDependency || hasDatabaseRequirement) {
    const exactDatabaseShape =
      candidate.databaseDependencies.length === 1 &&
      candidate.databaseDependencies[0] === "pg" &&
      databaseRequirements.length === 1 &&
      databaseRequirements[0]?.name === BACKEND_RUNTIME_DATABASE_ENV_NAME &&
      databaseRequirements[0]?.exposure === "server"

    if (!exactDatabaseShape) {
      return "The database dependency and requirement shape is not supported."
    }
  }

  const unsupportedRequirement = candidate.environmentRequirements.find(
    (requirement) =>
      !isSupportedPlatformRequirement(requirement) &&
      requirement.requirementKind !== "database-requirement" &&
      !isSupportedGeneratedSecretRequirement(requirement) &&
      !isUserConfigurableRequirement(requirement),
  )
  if (unsupportedRequirement) {
    return `Environment requirement "${unsupportedRequirement.name}" is not supported until ephemeral env/secrets provisioning exists.`
  }

  if (resolveUserEnvironmentNames(candidate.environmentRequirements) === null) {
    return "The backend declares more user-provided configuration variables than full-stack preview supports."
  }

  return null
}

function isSupportedPlatformRequirement(
  requirement: EnvironmentRequirement,
): boolean {
  return (
    requirement.requirementKind === "auto-configurable" &&
    ["PORT", "HOST", "NODE_ENV"].includes(requirement.name)
  )
}

function isSupportedGeneratedSecretRequirement(
  requirement: EnvironmentRequirement,
): requirement is EnvironmentRequirement & {
  name: PreviewGeneratedSecretName
  requirementKind: "preview-generated-candidate"
  exposure: "server"
} {
  return (
    requirement.requirementKind === "preview-generated-candidate" &&
    requirement.exposure === "server" &&
    isEligiblePreviewGeneratedSecretName(requirement.name)
  )
}

/**
 * Re-validates the entrypoint independently of
 * `core/analyzer/backendDetector.ts`'s own narrow-script-grammar
 * extraction: repository-relative, no traversal, no absolute path, and a
 * plain JavaScript extension only (`.ts`/`.mts`/`.cts` would require a
 * loader/transpiler this adapter does not run).
 */
function isSafeVerifiableEntrypoint(entrypoint: string | null): boolean {
  if (!entrypoint) return false
  if (entrypoint.startsWith("/")) return false
  if (
    entrypoint.split("/").some((segment) => segment === "" || segment === "..")
  )
    return false

  const extension = entrypoint.split(".").pop()
  return Boolean(extension && ONLY_ALLOWED_ENTRYPOINT_EXTENSIONS.has(extension))
}
