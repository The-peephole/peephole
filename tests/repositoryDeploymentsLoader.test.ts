import { describe, expect, it, vi } from "vitest"

import { RepositoryDeploymentsLoader } from "../core/github/repositoryDeploymentsLoader"
import type {
  GitHubDeploymentStatusesPage,
  GitHubDeploymentsPage,
} from "../core/github/client"

const repository = { owner: "acme", repo: "web" }

describe("RepositoryDeploymentsLoader", () => {
  it("reports not-detected with zero candidates when there are no deployments", async () => {
    const githubClient = {
      listRepositoryDeployments: vi
        .fn()
        .mockResolvedValue({ deployments: [], truncated: false }),
      listDeploymentStatuses: vi.fn(),
    }
    const loader = new RepositoryDeploymentsLoader(githubClient)

    const result = await loader.load(repository)

    expect(result).toMatchObject({ status: "not-detected", candidateCount: 0 })
    expect(githubClient.listDeploymentStatuses).not.toHaveBeenCalled()
  })

  it("confirms an actionable deployment discovered through a status lookup", async () => {
    const githubClient = {
      listRepositoryDeployments: vi.fn().mockResolvedValue({
        deployments: [
          {
            id: 1,
            sha: "a".repeat(40),
            ref: "main",
            environment: "production",
            productionEnvironment: true,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
        truncated: false,
      } satisfies GitHubDeploymentsPage),
      listDeploymentStatuses: vi.fn().mockResolvedValue({
        statuses: [
          {
            state: "success",
            environmentUrl: "https://example.com",
            createdAt: "2026-01-01T00:05:00Z",
          },
        ],
        truncated: false,
      } satisfies GitHubDeploymentStatusesPage),
    }
    const loader = new RepositoryDeploymentsLoader(githubClient)

    const result = await loader.load(repository)

    expect(result.status).toBe("confirmed")
    expect(result.candidate?.url).toBe("https://example.com")
    expect(githubClient.listDeploymentStatuses).toHaveBeenCalledWith(
      repository,
      1,
      undefined,
    )
  })

  it("picks the most recent status by createdAt regardless of API order", async () => {
    const githubClient = {
      listRepositoryDeployments: vi.fn().mockResolvedValue({
        deployments: [
          {
            id: 1,
            sha: "a".repeat(40),
            ref: "main",
            environment: "production",
            productionEnvironment: true,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
        truncated: false,
      }),
      listDeploymentStatuses: vi.fn().mockResolvedValue({
        statuses: [
          {
            state: "success",
            environmentUrl: "https://newest.example.com",
            createdAt: "2026-01-01T00:10:00Z",
          },
          {
            state: "failure",
            environmentUrl: null,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
        truncated: false,
      }),
    }
    const loader = new RepositoryDeploymentsLoader(githubClient)

    const result = await loader.load(repository)

    expect(result.candidate?.url).toBe("https://newest.example.com")
  })

  it("bounds status lookups to the top 5 ranked deployments and marks truncated", async () => {
    const deployments = Array.from({ length: 8 }, (_, index) => ({
      id: index + 1,
      sha: "a".repeat(40),
      ref: "main",
      environment: "preview",
      productionEnvironment: false,
      createdAt: "2026-01-01T00:00:00Z",
    }))
    const githubClient = {
      listRepositoryDeployments: vi
        .fn()
        .mockResolvedValue({ deployments, truncated: false }),
      listDeploymentStatuses: vi.fn().mockResolvedValue({
        statuses: [],
        truncated: false,
      }),
    }
    const loader = new RepositoryDeploymentsLoader(githubClient)

    const result = await loader.load(repository)

    expect(githubClient.listDeploymentStatuses).toHaveBeenCalledTimes(5)
    expect(result.candidateCount).toBe(5)
    expect(result.truncated).toBe(true)
  })

  it("records an unknown status for a deployment whose status lookup fails, without failing the whole load", async () => {
    const githubClient = {
      listRepositoryDeployments: vi.fn().mockResolvedValue({
        deployments: [
          {
            id: 1,
            sha: "a".repeat(40),
            ref: "main",
            environment: "production",
            productionEnvironment: true,
            createdAt: "2026-01-01T00:00:00Z",
          },
          {
            id: 2,
            sha: "b".repeat(40),
            ref: "main",
            environment: "preview",
            productionEnvironment: false,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
        truncated: false,
      }),
      listDeploymentStatuses: vi
        .fn()
        .mockRejectedValueOnce(new Error("rate limited"))
        .mockResolvedValueOnce({
          statuses: [
            {
              state: "success",
              environmentUrl: "https://example.com",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
          truncated: false,
        }),
    }
    const loader = new RepositoryDeploymentsLoader(githubClient)

    const result = await loader.load(repository)

    expect(result.status).toBe("confirmed")
    expect(result.candidate?.url).toBe("https://example.com")
  })

  it("propagates an abort instead of swallowing it as a status failure", async () => {
    const abortError = new DOMException("aborted", "AbortError")
    const githubClient = {
      listRepositoryDeployments: vi.fn().mockResolvedValue({
        deployments: [
          {
            id: 1,
            sha: "a".repeat(40),
            ref: "main",
            environment: "production",
            productionEnvironment: true,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
        truncated: false,
      }),
      listDeploymentStatuses: vi.fn().mockRejectedValue(abortError),
    }
    const loader = new RepositoryDeploymentsLoader(githubClient)

    await expect(loader.load(repository)).rejects.toBe(abortError)
  })

  it("marks truncated when the deployment list itself was truncated", async () => {
    const githubClient = {
      listRepositoryDeployments: vi.fn().mockResolvedValue({
        deployments: [
          {
            id: 1,
            sha: "a".repeat(40),
            ref: "main",
            environment: "production",
            productionEnvironment: true,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
        truncated: true,
      }),
      listDeploymentStatuses: vi.fn().mockResolvedValue({
        statuses: [
          {
            state: "success",
            environmentUrl: "https://example.com",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
        truncated: false,
      }),
    }
    const loader = new RepositoryDeploymentsLoader(githubClient)

    const result = await loader.load(repository)

    expect(result.truncated).toBe(true)
  })
})
