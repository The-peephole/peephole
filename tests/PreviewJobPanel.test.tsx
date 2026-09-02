// @vitest-environment jsdom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { PreviewJobPanel } from "../components/PreviewJobPanel"
import type { PreviewApi } from "../core/preview/apiClient"
import type { PreviewJob } from "../types/preview"
import { supportedAnalysis } from "./analysisFixture"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

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

describe("PreviewJobPanel", () => {
  const roots: Array<ReturnType<typeof createRoot>> = []

  afterEach(() => {
    vi.useRealTimers()
    for (const root of roots) act(() => root.unmount())
    roots.length = 0
    document.body.innerHTML = ""
  })

  it("explains when the preview service is not configured", async () => {
    const container = await renderPanel(null, roots)
    const button = getButton("Build preview")

    expect(button.disabled).toBe(true)
    expect(container.textContent).toContain("WXT_PREVIEW_API_BASE_URL")
  })

  it("creates a pinned job and supports cancellation", async () => {
    const cancelledJob = { ...queuedJob, status: "cancelled" as const }
    const api = createApi({
      create: vi.fn().mockResolvedValue(queuedJob),
      cancel: vi.fn().mockResolvedValue(cancelledJob),
    })
    const container = await renderPanel(api, roots)

    await act(async () => getButton("Build preview").click())
    expect(api.create).toHaveBeenCalledWith(
      {
        repository: queuedJob.repository,
        contractVersion: "static-v1",
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(container.textContent).toContain("Queued")

    await act(async () => getButton("Cancel").click())
    expect(api.cancel).toHaveBeenCalledWith(
      queuedJob.id,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(container.textContent).toContain("Preview cancelled")
  })

  it("polls an active job until it is ready", async () => {
    vi.useFakeTimers()
    const readyJob = { ...queuedJob, status: "ready" as const }
    const api = createApi({
      create: vi.fn().mockResolvedValue(queuedJob),
      get: vi.fn().mockResolvedValue(readyJob),
    })
    const container = await renderPanel(api, roots, 10)

    await act(async () => getButton("Build preview").click())
    await act(async () => vi.advanceTimersByTimeAsync(10))

    expect(api.get).toHaveBeenCalledWith(
      queuedJob.id,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(container.textContent).toContain("Preview ready")
  })

  it("aborts an in-flight creation when the panel is detached", async () => {
    let signal: AbortSignal | undefined
    const api = createApi({
      create: vi.fn((_request, options) => {
        signal = options?.signal
        return new Promise<PreviewJob>(() => undefined)
      }),
    })
    await renderPanel(api, roots)

    await act(async () => getButton("Build preview").click())
    expect(signal?.aborted).toBe(false)

    const root = roots.pop()
    await act(async () => root?.unmount())
    expect(signal?.aborted).toBe(true)
  })

  it("does not offer a job for an unsupported analysis", async () => {
    const api = createApi()
    const container = await renderPanel(api, roots, 10, {
      ...supportedAnalysis,
      preview: {
        ...supportedAnalysis.preview,
        mode: "unsupported",
        blockers: [{ code: "BACKEND_REQUIRED", message: "Backend required." }],
      },
    })

    expect(container.textContent).toBe("")
    expect(api.create).not.toHaveBeenCalled()
  })

  it("does not replace a confirmed existing deployment with a native job", async () => {
    const api = createApi()
    const container = await renderPanel(api, roots, 10, {
      ...supportedAnalysis,
      preview: { ...supportedAnalysis.preview, mode: "existing-deployment" },
    })

    expect(container.textContent).toBe("")
    expect(api.create).not.toHaveBeenCalled()
  })
})

function createApi(overrides: Partial<PreviewApi> = {}): PreviewApi {
  return {
    create: vi.fn().mockRejectedValue(new Error("Not configured in test.")),
    get: vi.fn().mockRejectedValue(new Error("Not configured in test.")),
    cancel: vi.fn().mockRejectedValue(new Error("Not configured in test.")),
    ...overrides,
  }
}

async function renderPanel(
  previewApi: PreviewApi | null,
  roots: Array<ReturnType<typeof createRoot>>,
  pollIntervalMs = 1_500,
  analysis = supportedAnalysis,
): Promise<HTMLDivElement> {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)

  await act(async () => {
    root.render(
      <PreviewJobPanel
        analysis={analysis}
        pollIntervalMs={pollIntervalMs}
        previewApi={previewApi}
      />,
    )
  })
  return container
}

function getButton(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.includes(label),
  )
  if (!button) throw new Error(`Button not found: ${label}`)
  return button
}
