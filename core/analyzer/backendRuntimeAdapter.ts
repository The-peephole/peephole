import type { BackendCandidate } from "../../types/backend"
import type {
  BackendExecutionSupport,
  BackendRuntimeAdapterId,
  BackendRuntimePlan,
} from "../../types/backendRuntime"
import { BACKEND_RUNTIME_CONTRACT_VERSION } from "../../types/backendRuntime"
import type { PreviewRepositoryRef } from "../../types/preview"
import { isSafePreviewSourceRoot } from "../preview/sourceRoot"

/**
 * `express-node-npm-v1` is the only implemented backend-v1 adapter. It is
 * DETECTION-TO-EXECUTION only for a very narrow shape -- see
 * `docs/PREVIEW_RUNTIME.md`. A candidate detected by M7
 * (`core/analyzer/backendDetector.ts`) with a *different* framework, a
 * database dependency, a missing lockfile, an unresolved entrypoint, or any
 * environment requirement outside the fixed `PORT`/`HOST`/`NODE_ENV`
 * allowlist is never supported here -- "Backend detected" and "Execution
 * supported" are always evaluated separately, and this function is the
 * single place that draws that line for both client-side display and
 * server-side authorization. It never trusts anything client-provided:
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
  const rejection = findUnsupportedReason(candidate)

  if (rejection) {
    return { supported: false, adapterId: null, evidence: [rejection] }
  }

  return {
    supported: true,
    adapterId: "express-node-npm-v1",
    evidence: [
      "express dependency, package-lock.json, a safe Node entrypoint, and only platform-owned environment requirements were found",
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
  if (findUnsupportedReason(candidate)) return null

  // findUnsupportedReason already proved these are non-null/safe.
  const entrypoint = candidate.entrypoint!

  const adapterId: BackendRuntimeAdapterId = "express-node-npm-v1"

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
  }
}

function findUnsupportedReason(candidate: BackendCandidate): string | null {
  if (candidate.framework !== "express") {
    return `${candidate.framework} execution is not supported yet.`
  }

  if (!isSafePreviewSourceRoot(candidate.sourceRoot)) {
    return "The backend source root is not safe to execute."
  }

  if (!candidate.packageLockPresent) {
    return "package-lock.json is required for backend-v1 execution."
  }

  if (!isSafeVerifiableEntrypoint(candidate.entrypoint)) {
    return "A safe Node entrypoint could not be resolved."
  }

  if (candidate.databaseDependencies.length > 0) {
    return "Database dependencies are not supported until temporary database provisioning exists."
  }

  const unsupportedRequirement = candidate.environmentRequirements.find(
    (requirement) => requirement.requirementKind !== "auto-configurable",
  )
  if (unsupportedRequirement) {
    return `Environment requirement "${unsupportedRequirement.name}" is not supported until ephemeral env/secrets provisioning exists.`
  }

  return null
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
