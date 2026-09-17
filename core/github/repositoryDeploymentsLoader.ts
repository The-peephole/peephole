import {
  MAX_DEPLOYMENT_STATUS_LOOKUPS,
  rankDeploymentsForStatusLookup,
  selectLiveDeployment,
  type DeploymentStatusLookupResult,
} from "../analyzer/liveDeploymentSelector"
import type { RepositoryLiveDeployment } from "../../types/deployment"
import type { RepositoryIdentity } from "../../types/repository"
import type {
  GitHubDeploymentStatusSummary,
  GitHubDeploymentsPage,
  GitHubDeploymentStatusesPage,
} from "./client"

interface DeploymentsGitHubSource {
  listRepositoryDeployments(
    repository: RepositoryIdentity,
    signal?: AbortSignal,
  ): Promise<GitHubDeploymentsPage>
  listDeploymentStatuses(
    repository: RepositoryIdentity,
    deploymentId: number,
    signal?: AbortSignal,
  ): Promise<GitHubDeploymentStatusesPage>
}

/**
 * Discovers a repository's current actionable live deployment from a
 * bounded slice of its GitHub deployment history
 * (`GitHubClient.listRepositoryDeployments`,
 * `GitHubClient.listDeploymentStatuses`). Never paginates beyond those fixed
 * bounds; hitting one sets `truncated` instead of hiding it. A single
 * deployment's status-lookup failure is recorded as an unknown status for
 * that deployment and does not fail the whole lookup -- only an abort
 * propagates. This loader is intentionally separate from
 * `RepositoryAnalysisService`: its result is mutable, short-lived state, not
 * part of the immutable per-commit `RepositoryAnalysis`.
 */
export class RepositoryDeploymentsLoader {
  constructor(private readonly githubClient: DeploymentsGitHubSource) {}

  async load(
    repository: RepositoryIdentity,
    signal?: AbortSignal,
  ): Promise<RepositoryLiveDeployment> {
    const { deployments, truncated: listTruncated } =
      await this.githubClient.listRepositoryDeployments(repository, signal)

    if (deployments.length === 0) {
      return {
        status: "not-detected",
        candidate: null,
        candidateCount: 0,
        truncated: listTruncated,
        evidence: ["No GitHub deployments were found for this repository"],
      }
    }

    const ranked = rankDeploymentsForStatusLookup(deployments)
    const bounded = ranked.slice(0, MAX_DEPLOYMENT_STATUS_LOOKUPS)
    let truncated = listTruncated || ranked.length > bounded.length

    const lookups: DeploymentStatusLookupResult[] = []
    for (const deployment of bounded) {
      try {
        const page = await this.githubClient.listDeploymentStatuses(
          repository,
          deployment.id,
          signal,
        )
        if (page.truncated) truncated = true
        lookups.push({
          deployment,
          status: mostRecentStatus(page.statuses),
        })
      } catch (error) {
        if (isAbortError(error)) throw error
        lookups.push({ deployment, status: null })
      }
    }

    return selectLiveDeployment(lookups, truncated)
  }
}

function mostRecentStatus(
  statuses: readonly GitHubDeploymentStatusSummary[],
): GitHubDeploymentStatusSummary | null {
  if (statuses.length === 0) return null

  return statuses.reduce((latest, status) =>
    Date.parse(status.createdAt) > Date.parse(latest.createdAt)
      ? status
      : latest,
  )
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}
