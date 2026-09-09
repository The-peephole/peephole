// @vitest-environment jsdom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PreviewJobPanel } from "../components/PreviewJobPanel"
import { PreviewApiError, type PreviewApi } from "../core/preview/apiClient"
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
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(queuedJob.createdAt))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
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

  it("resends the create request when Retry is clicked after a failure", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("The Peephole preview service could not be reached."),
      )
      .mockResolvedValueOnce(queuedJob)
    const api = createApi({ create })
    const container = await renderPanel(api, roots)

    await act(async () => getButton("Build preview").click())
    expect(container.textContent).toContain("Preview request failed")
    expect(create).toHaveBeenCalledTimes(1)

    await act(async () => getButton("Retry").click())
    expect(create).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain("Queued")
  })

  it("offers GitHub reconnection when the Peephole session expires", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        new PreviewApiError(
          "UNAUTHORIZED",
          "Connect GitHub to build a preview.",
        ),
      )
      .mockResolvedValueOnce(queuedJob)
    const connectGitHub = vi.fn().mockResolvedValue(undefined)
    const container = await renderPanel(
      createApi({ create }),
      roots,
      1_500,
      supportedAnalysis,
      null,
      connectGitHub,
    )

    await act(async () => getButton("Build preview").click())
    expect(container.textContent).toContain("Connect GitHub to build a preview")
    await act(async () => getButton("Connect GitHub").click())

    expect(connectGitHub).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain("Queued")
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

  it("embeds a sandboxed iframe for a trusted loopback artifact origin", async () => {
    const readyJob: PreviewJob = {
      ...queuedJob,
      status: "ready",
      artifact: {
        url: "http://127.0.0.1:54321/",
        expiresAt: "2026-09-02T01:00:00.000Z",
      },
    }
    const api = createApi({ create: vi.fn().mockResolvedValue(readyJob) })
    const container = await renderPanel(api, roots)

    await act(async () => getButton("Build preview").click())

    const iframe = container.querySelector("iframe")
    expect(iframe?.getAttribute("src")).toBe("http://127.0.0.1:54321/")
    expect(iframe?.getAttribute("sandbox")).toContain("allow-scripts")
    expect(iframe?.getAttribute("referrerpolicy")).toBe("no-referrer")
  })

  it.each([
    [
      "https://artifact-12345678-1234-1234-1234-123456789abc.3.34.33.24.nip.io/path",
      true,
    ],
    ["https://artifact-12345678-1234-1234-1234-123456789abc.evil.com/", false],
  ])(
    "gates production iframe and new-tab link for %s",
    async (url, trusted) => {
      const api = createApi({
        create: vi.fn().mockResolvedValue({
          ...queuedJob,
          status: "ready",
          artifact: { url, expiresAt: queuedJob.expiresAt },
        }),
      })
      const container = await renderPanel(
        api,
        roots,
        1500,
        supportedAnalysis,
        "3.34.33.24.nip.io",
      )
      await act(async () => getButton("Build preview").click())
      const iframe = container.querySelector("iframe")
      const link = container.querySelector('a[target="_blank"]')
      if (trusted) {
        expect(iframe?.getAttribute("src")).toBe(url)
        expect(iframe?.getAttribute("sandbox")).toBe(
          "allow-scripts allow-same-origin allow-forms",
        )
        expect(iframe?.getAttribute("referrerpolicy")).toBe("no-referrer")
        expect(link?.getAttribute("href")).toBe(url)
      } else {
        expect(iframe).toBeNull()
        expect(link).toBeNull()
      }
    },
  )

  it("refuses to embed an artifact from an untrusted origin", async () => {
    const readyJob: PreviewJob = {
      ...queuedJob,
      status: "ready",
      artifact: {
        url: "https://attacker.example/",
        expiresAt: "2026-09-02T01:00:00.000Z",
      },
    }
    const api = createApi({ create: vi.fn().mockResolvedValue(readyJob) })
    const container = await renderPanel(api, roots)

    await act(async () => getButton("Build preview").click())

    expect(container.querySelector("iframe")).toBeNull()
    expect(container.textContent).toContain("not approved for embedding")
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

  it("expires a ready preview, removes the iframe, and offers a new build", async () => {
    vi.useFakeTimers()
    const ready: PreviewJob = {
      ...queuedJob,
      status: "ready",
      expiresAt: new Date(Date.now() + 1000).toISOString(),
      artifact: {
        url: "http://127.0.0.1:54321/",
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      },
    }
    const api = createApi({ create: vi.fn().mockResolvedValue(ready) })
    const container = await renderPanel(api, roots)
    await act(async () => getButton("Build preview").click())
    expect(container.querySelector("iframe")).not.toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(container.querySelector("iframe")).toBeNull()
    expect(container.textContent).toContain("Preview expired")
    expect(getButton("Build again")).toBeDefined()
  })

  it("rechecks the existing job after a polling failure without creating another build", async () => {
    vi.useFakeTimers()
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error("Temporary network failure"))
      .mockResolvedValue({ ...queuedJob, status: "building" })
    const api = createApi({ create: vi.fn().mockResolvedValue(queuedJob), get })
    const container = await renderPanel(api, roots, 10)
    await act(async () => getButton("Build preview").click())
    await act(async () => vi.advanceTimersByTimeAsync(10))
    expect(container.textContent).toContain("Temporary network failure")
    await act(async () => getButton("Check status").click())
    await act(async () => vi.advanceTimersByTimeAsync(10))
    expect(container.textContent).toContain("Building preview")
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it("reuses the idempotency key when a create response is lost", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("Response lost"))
      .mockResolvedValue(queuedJob)
    await renderPanel(createApi({ create }), roots)
    await act(async () => getButton("Build preview").click())
    await act(async () => getButton("Retry").click())
    expect(create.mock.calls[0]?.[1].idempotencyKey).toBe(
      create.mock.calls[1]?.[1].idempotencyKey,
    )
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
  previewArtifactBaseDomain: string | null = null,
  connectGitHub: (() => Promise<void>) | null = null,
): Promise<HTMLDivElement> {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)

  await act(async () => {
    root.render(
      <PreviewJobPanel
        analysis={analysis}
        connectGitHub={connectGitHub}
        pollIntervalMs={pollIntervalMs}
        previewApi={previewApi}
        previewArtifactBaseDomain={previewArtifactBaseDomain}
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
