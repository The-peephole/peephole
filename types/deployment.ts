import type { RepositoryIdentity } from "./repository"

/**
 * `confirmed` means a bounded GitHub Deployments API lookup found an
 * actionable candidate (a successful status with a validated, safe HTTPS
 * `environment_url`). `not-detected` means the lookup completed but found no
 * such candidate -- it never means the lookup failed; a failed lookup is
 * surfaced as a rejected loader promise / message error instead, so a
 * transient GitHub failure is never confused with a genuine absence of
 * deployment evidence.
 */
export type LiveDeploymentStatus = "confirmed" | "not-detected"

export interface LiveDeploymentCandidate {
  environment: string
  productionEnvironment: boolean
  /** Already validated by `core/github/externalUrlPolicy.ts` (HTTPS only). */
  url: string
  ref: string | null
  sha: string | null
  state: string
}

export interface RepositoryLiveDeployment {
  status: LiveDeploymentStatus
  /** Non-null only when `status` is `"confirmed"`. */
  candidate: LiveDeploymentCandidate | null
  /** Number of deployments actually inspected within the bounded lookup. */
  candidateCount: number
  /** Set whenever a bound (deployment list or status-lookup count/page) was reached. */
  truncated: boolean
  evidence: string[]
}

export interface RepositoryLiveDeploymentLoadOptions {
  signal?: AbortSignal
}

/**
 * Loads mutable current-deployment state for a repository. Deliberately
 * keyed by repository identity only -- never by commit SHA or branch -- and
 * never combined with `RepositoryAnalysisLoader`'s immutable, SHA-keyed
 * cache.
 */
export type RepositoryLiveDeploymentLoader = (
  repository: RepositoryIdentity,
  options?: RepositoryLiveDeploymentLoadOptions,
) => Promise<RepositoryLiveDeployment>
