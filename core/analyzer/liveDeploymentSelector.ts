import type {
  GitHubDeploymentStatusSummary,
  GitHubDeploymentSummary,
} from "../github/client"
import { isSafeExternalUrl } from "../github/externalUrlPolicy"
import type {
  LiveDeploymentCandidate,
  RepositoryLiveDeployment,
} from "../../types/deployment"

/** Bounded number of deployments that ever receive a status lookup. */
export const MAX_DEPLOYMENT_STATUS_LOOKUPS = 5

const ACTIONABLE_STATUS_STATES = new Set(["success"])
const PRODUCTION_ENVIRONMENT_NAME_PATTERN = /prod/i

export interface DeploymentStatusLookupResult {
  deployment: GitHubDeploymentSummary
  /** Null when the status lookup for this deployment failed or was skipped. */
  status: GitHubDeploymentStatusSummary | null
}

/**
 * Orders deployments for the bounded status-lookup pass: `production_environment`
 * deployments first, then deployments whose environment name reads as
 * production, then everything else -- each tier keeping its relative (most
 * recent Github API result) order via a stable sort. Only the first
 * `MAX_DEPLOYMENT_STATUS_LOOKUPS` entries of the result should ever receive a
 * status lookup.
 */
export function rankDeploymentsForStatusLookup(
  deployments: readonly GitHubDeploymentSummary[],
): GitHubDeploymentSummary[] {
  return [...deployments].sort((a, b) => tier(a) - tier(b))
}

function tier(deployment: GitHubDeploymentSummary): number {
  if (deployment.productionEnvironment) return 0
  if (PRODUCTION_ENVIRONMENT_NAME_PATTERN.test(deployment.environment)) return 1
  return 2
}

/**
 * Selects the single actionable live deployment, if any, from a bounded set
 * of deployments paired with their most-recent status. A deployment is only
 * ever selected when its most recent status is `success` and reports a
 * validated, safe HTTPS `environment_url` -- a failed/inactive/pending
 * status or a missing/unsafe URL is never treated as actionable regardless
 * of environment name. Among actionable candidates, the same tiering used
 * for lookup ranking (`production_environment`, then a production-like
 * environment name, then anything else) selects the single result.
 */
export function selectLiveDeployment(
  lookups: readonly DeploymentStatusLookupResult[],
  truncated: boolean,
): RepositoryLiveDeployment {
  const evidence: string[] = [
    `${lookups.length} recent deployment${lookups.length === 1 ? "" : "s"} inspected`,
  ]
  if (lookups.some((lookup) => lookup.status === null)) {
    evidence.push("One or more deployment statuses could not be read")
  }

  const actionable = lookups
    .map(toActionableCandidate)
    .filter(
      (entry): entry is { tier: number; candidate: LiveDeploymentCandidate } =>
        entry !== null,
    )
    .sort((a, b) => a.tier - b.tier)

  if (actionable.length === 0) {
    return {
      status: "not-detected",
      candidate: null,
      candidateCount: lookups.length,
      truncated,
      evidence,
    }
  }

  const selected = actionable[0]!.candidate
  evidence.push(
    selected.productionEnvironment
      ? "Selected the production-environment deployment with a successful status and a valid URL"
      : "Selected the most actionable recent deployment with a successful status and a valid URL",
  )

  return {
    status: "confirmed",
    candidate: selected,
    candidateCount: lookups.length,
    truncated,
    evidence,
  }
}

function toActionableCandidate(
  lookup: DeploymentStatusLookupResult,
): { tier: number; candidate: LiveDeploymentCandidate } | null {
  const { deployment, status } = lookup
  if (!status) return null
  if (!ACTIONABLE_STATUS_STATES.has(status.state)) return null
  if (!status.environmentUrl || !isSafeExternalUrl(status.environmentUrl)) {
    return null
  }

  return {
    tier: tier(deployment),
    candidate: {
      environment: deployment.environment,
      productionEnvironment: deployment.productionEnvironment,
      url: status.environmentUrl,
      ref: deployment.ref,
      sha: deployment.sha,
      state: status.state,
    },
  }
}
