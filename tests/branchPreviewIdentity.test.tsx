// @vitest-environment jsdom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { PreviewJobPanel } from "../components/PreviewJobPanel"
import type { PreviewApi } from "../core/preview/apiClient"
import type { RepositoryAnalysis } from "../types/analysis"
import type { PreviewJob } from "../types/preview"
import { supportedAnalysis } from "./analysisFixture"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const activeSession = {
  token: "peephole-session",
  expiresAt: "2099-01-01T00:00:00.000Z",
}

const queuedJob: PreviewJob = {
  id: "job-00000001",
  repository: {
    repositoryId: supportedAnalysis.repository.repositoryId,
    owner: supportedAnalysis.repository.owner,
    name: supportedAnalysis.repository.repo,
    commitSha: supportedAnalysis.repository.commitSha,
  },
  plan: {
    contractVersion: "static-v1",
    repository: {
      repositoryId: supportedAnalysis.repository.repositoryId,
      owner: supportedAnalysis.repository.owner,
      name: supportedAnalysis.repository.repo,
      commitSha: supportedAnalysis.repository.commitSha,
    },
    sourceRoot: ".",
    packageManager: "npm",
    installCommand: "npm ci",
    buildCommand: "npm run build",
    outputDirectory: "dist",
  },
  cacheKey: "cache-key",
  cacheStatus: "miss",
  status: "queued",
  artifact: null,
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  expiresAt: "2026-09-02T01:00:00.000Z",
}

/**
 * These tests exercise the exact identity contract the Side Panel's
 * SidePanelApp uses to key PreviewJobPanel:
 * `${repositoryId}:${commitSha}`. Branch Preview must not create a new
 * preview identity just because the branch label changed.
 */
describe("branch preview identity (repositoryId:commitSha)", () => {
  const roots: Array<ReturnType<typeof createRoot>> = []

  afterEach(() => {
    for (const root of roots) act(() => root.unmount())
    roots.length = 0
    document.body.innerHTML = ""
  })

  it("preserves an in-flight preview job when a different branch resolves to the same commit SHA", async () => {
    const api = createApi({ create: vi.fn().mockResolvedValue(queuedJob) })
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(renderWithAppKey(supportedAnalysis, api))
    })
    await act(async () => getButton(container, "Build preview").click())
    expect(container.textContent).toContain("Queued")

    // A second branch that happens to point at the same commit SHA: same
    // repositoryId:commitSha identity, so React must reuse the instance.
    const sameCommitOtherBranch: RepositoryAnalysis = { ...supportedAnalysis }
    await act(async () => {
      root.render(renderWithAppKey(sameCommitOtherBranch, api))
    })

    expect(container.textContent).toContain("Queued")
    expect(api.create).toHaveBeenCalledTimes(1)
  })

  it("resets preview state when the selected branch resolves to a different commit SHA", async () => {
    const api = createApi({ create: vi.fn().mockResolvedValue(queuedJob) })
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(renderWithAppKey(supportedAnalysis, api))
    })
    await act(async () => getButton(container, "Build preview").click())
    expect(container.textContent).toContain("Queued")

    const differentCommit: RepositoryAnalysis = {
      ...supportedAnalysis,
      repository: {
        ...supportedAnalysis.repository,
        commitSha: "b".repeat(40),
      },
    }
    await act(async () => {
      root.render(renderWithAppKey(differentCommit, api))
    })

    expect(container.textContent).toContain("Build preview")
    expect(container.textContent).not.toContain("Queued")
  })
})

function renderWithAppKey(
  analysis: RepositoryAnalysis,
  previewApi: PreviewApi,
) {
  return (
    <PreviewJobPanel
      analysis={analysis}
      clearSession={() => Promise.resolve(undefined)}
      getSession={() => Promise.resolve(activeSession)}
      key={`${analysis.repository.repositoryId}:${analysis.repository.commitSha}`}
      previewApi={previewApi}
    />
  )
}

function createApi(overrides: Partial<PreviewApi> = {}): PreviewApi {
  return {
    create: vi.fn().mockRejectedValue(new Error("Not configured in test.")),
    get: vi.fn().mockRejectedValue(new Error("Not configured in test.")),
    cancel: vi.fn().mockRejectedValue(new Error("Not configured in test.")),
    ...overrides,
  }
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.includes(label),
  )
  if (!button) throw new Error(`Button not found: ${label}`)
  return button
}
