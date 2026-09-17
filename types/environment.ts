/**
 * Environment *requirement* classification -- detection only. This never
 * reads, stores, generates, or transmits an actual secret value; it only
 * reasons about declared variable *names* found in a bounded set of
 * `.env.example`-family template files (see
 * `core/analyzer/environmentRequirements.ts`).
 */

/** Where a variable's value is exposed once the application runs. */
export type EnvironmentExposure = "client-public" | "server" | "unknown"

/**
 * What Peephole (in a *future* stage) could plausibly do about this
 * variable. None of these kinds are acted upon in this stage: no value is
 * generated, injected, or requested from the user here.
 */
export type EnvironmentRequirementKind =
  | "auto-configurable"
  | "preview-generated-candidate"
  | "external-routing-candidate"
  | "database-requirement"
  | "user-required"
  | "unknown"

/** How sensitive the variable's value is presumed to be, by name only. */
export type EnvironmentSensitivity = "public" | "secret-like" | "unknown"

export interface EnvironmentRequirement {
  name: string
  /** Repository-relative source root this requirement was found under. */
  sourceRoot: string
  /** Which known template file declared this name. */
  sourceTemplate: string
  exposure: EnvironmentExposure
  requirementKind: EnvironmentRequirementKind
  sensitivity: EnvironmentSensitivity
  evidence: string[]
  warnings: string[]
}
