import { describe, expect, it } from "vitest"

import {
  MAX_DEPLOYMENT_STATUS_LOOKUPS,
  rankDeploymentsForStatusLookup,
  selectLiveDeployment,
  type DeploymentStatusLookupResult,
} from "../core/analyzer/liveDeploymentSelector"
import type {
  GitHubDeploymentStatusSummary,
  GitHubDeploymentSummary,
} from "../core/github/client"

describe("rankDeploymentsForStatusLookup", () => {
  it("ranks production_environment deployments first", () => {
    const preview = deployment({ id: 1, environment: "preview" })
    const production = deployment({
      id: 2,
      environment: "production",
      productionEnvironment: true,
    })

    expect(rankDeploymentsForStatusLookup([preview, production])).toEqual([
      production,
      preview,
    ])
  })

  it("ranks a production-like environment name above an unrelated one", () => {
    const staging = deployment({ id: 1, environment: "staging" })
    const productionName = deployment({ id: 2, environment: "production" })

    expect(rankDeploymentsForStatusLookup([staging, productionName])).toEqual([
      productionName,
      staging,
    ])
  })

  it("keeps stable relative order within a tier", () => {
    const first = deployment({ id: 1, environment: "review-a" })
    const second = deployment({ id: 2, environment: "review-b" })

    expect(rankDeploymentsForStatusLookup([first, second])).toEqual([
      first,
      second,
    ])
  })
})

describe("selectLiveDeployment", () => {
  it("confirms a production deployment with a successful status and a valid URL", () => {
    const lookups: DeploymentStatusLookupResult[] = [
      {
        deployment: deployment({
          id: 1,
          environment: "production",
          productionEnvironment: true,
        }),
        status: status({
          state: "success",
          environmentUrl: "https://example.com",
        }),
      },
    ]

    const result = selectLiveDeployment(lookups, false)

    expect(result.status).toBe("confirmed")
    expect(result.candidate).toMatchObject({
      environment: "production",
      productionEnvironment: true,
      url: "https://example.com",
    })
  })

  it("prefers a production_environment candidate over a preview candidate", () => {
    const lookups: DeploymentStatusLookupResult[] = [
      {
        deployment: deployment({ id: 1, environment: "preview" }),
        status: status({
          state: "success",
          environmentUrl: "https://preview.example.com",
        }),
      },
      {
        deployment: deployment({
          id: 2,
          environment: "production",
          productionEnvironment: true,
        }),
        status: status({
          state: "success",
          environmentUrl: "https://example.com",
        }),
      },
    ]

    const result = selectLiveDeployment(lookups, false)

    expect(result.candidate?.url).toBe("https://example.com")
  })

  it("does not select a deployment with no environment_url", () => {
    const lookups: DeploymentStatusLookupResult[] = [
      {
        deployment: deployment({ id: 1, environment: "production" }),
        status: status({ state: "success", environmentUrl: null }),
      },
    ]

    expect(selectLiveDeployment(lookups, false).status).toBe("not-detected")
  })

  it("does not select a failed deployment status", () => {
    const lookups: DeploymentStatusLookupResult[] = [
      {
        deployment: deployment({ id: 1, environment: "production" }),
        status: status({
          state: "failure",
          environmentUrl: "https://example.com",
        }),
      },
    ]

    expect(selectLiveDeployment(lookups, false).status).toBe("not-detected")
  })

  it.each(["inactive", "error", "pending", "in_progress", "queued"])(
    "does not select a %s deployment status",
    (state) => {
      const lookups: DeploymentStatusLookupResult[] = [
        {
          deployment: deployment({ id: 1, environment: "production" }),
          status: status({ state, environmentUrl: "https://example.com" }),
        },
      ]

      expect(selectLiveDeployment(lookups, false).status).toBe("not-detected")
    },
  )

  it("does not select a deployment with an unsafe environment_url", () => {
    const lookups: DeploymentStatusLookupResult[] = [
      {
        deployment: deployment({ id: 1, environment: "production" }),
        status: status({
          state: "success",
          environmentUrl: "http://127.0.0.1",
        }),
      },
    ]

    expect(selectLiveDeployment(lookups, false).status).toBe("not-detected")
  })

  it("reports not-detected with zero candidates when no lookups were made", () => {
    const result = selectLiveDeployment([], false)

    expect(result).toMatchObject({
      status: "not-detected",
      candidate: null,
      candidateCount: 0,
    })
  })

  it("propagates the truncated flag", () => {
    const lookups: DeploymentStatusLookupResult[] = [
      {
        deployment: deployment({ id: 1, environment: "production" }),
        status: status({
          state: "success",
          environmentUrl: "https://example.com",
        }),
      },
    ]

    expect(selectLiveDeployment(lookups, true).truncated).toBe(true)
  })

  it("bounds status lookups to MAX_DEPLOYMENT_STATUS_LOOKUPS", () => {
    expect(MAX_DEPLOYMENT_STATUS_LOOKUPS).toBe(5)
  })
})

function deployment(
  overrides: Partial<GitHubDeploymentSummary> & {
    id: number
    environment: string
  },
): GitHubDeploymentSummary {
  return {
    sha: "a".repeat(40),
    ref: "main",
    productionEnvironment: false,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

function status(
  overrides: Partial<GitHubDeploymentStatusSummary> & { state: string },
): GitHubDeploymentStatusSummary {
  return {
    environmentUrl: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}
