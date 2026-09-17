import type { EnvironmentRequirement } from "./environment"

/**
 * Backend detection is DETECTION ONLY. A `BackendCandidate` describes
 * evidence found in repository metadata; it is never executed, started, or
 * offered as a preview target. `BuildAdapterId` (`core/preview/buildAdapters.ts`)
 * is unaffected -- there is no `express-v1`/`nestjs-v1`/etc. adapter, and
 * there will not be one from this stage alone.
 */
export type BackendFramework =
  "express" | "nestjs" | "fastify" | "koa" | "hapi" | "unknown"

export type BackendDetectionStatus = "detected" | "not-detected"

export interface BackendCandidate {
  /** Repository-relative POSIX path; "." for the repository root. */
  sourceRoot: string
  framework: BackendFramework
  runtime: "node"
  packageName: string | null
  /**
   * A safe, textually-derived entrypoint file name from a narrow
   * `node <path>`-style start/dev script, or null when none could be
   * safely resolved. This is never verified to actually exist on GitHub;
   * it is unread, unexecuted evidence only.
   */
  entrypoint: string | null
  /** Names of recognized database/server-side dependencies, if any. */
  databaseDependencies: string[]
  environmentRequirements: EnvironmentRequirement[]
  /**
   * Whether `{sourceRoot}/package-lock.json` was found. This is bounded
   * evidence for a *future* execution-support signal (see
   * `types/backendRuntime.ts`'s `BackendExecutionSupport`) -- it is never
   * itself an authorization to execute anything, and a real backend
   * runtime job always re-verifies this independently at the exact commit.
   */
  packageLockPresent: boolean
  evidence: string[]
  warnings: string[]
}

export interface BackendDetection {
  status: BackendDetectionStatus
  candidates: BackendCandidate[]
  /** Evidence that applies to the repository as a whole (e.g. hosted-client notes). */
  evidence: string[]
  warnings: string[]
  /** False when a bounded read failed, as opposed to a bound being reached. */
  complete: boolean
  /** True when a bound was reached and more backend evidence may exist. */
  truncated: boolean
}
