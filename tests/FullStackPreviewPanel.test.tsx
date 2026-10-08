// @vitest-environment jsdom

import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { FullStackPreviewPanel } from "../components/FullStackPreviewPanel"
import type { FullStackPreviewApi } from "../core/fullstack/apiClient"
import { toRootBuildTargetAnalysis } from "../core/preview/buildAdapters"
import type { BuildTargetAnalysis, RepositoryAnalysis } from "../types/analysis"
import type { BackendCandidate } from "../types/backend"
import type { FullStackPreview } from "../types/fullstackPreview"
import { supportedAnalysis } from "./analysisFixture"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const databaseBackend: BackendCandidate = {
  sourceRoot: "backend",
  framework: "express",
  runtime: "node",
  packageName: "fixture-backend",
  packageManager: "npm@10.0.0",
  entrypoint: "src/server.js",
  databaseDependencies: ["pg"],
  environmentRequirements: [
    {
      name: "DATABASE_URL",
      sourceRoot: "backend",
      sourceTemplate: ".env.example",
      exposure: "server",
      requirementKind: "database-requirement",
      sensitivity: "secret-like",
      evidence: [],
      warnings: [],
    },
  ],
  packageLockPresent: true,
  evidence: ["express and pg dependencies detected"],
  warnings: [],
}

const analysis = createAnalysis([databaseBackend])
const queued: FullStackPreview = {
  id: "fullstack-12345678-1234-1234-1234-123456789abc",
  repository: {
    repositoryId: analysis.repository.repositoryId,
    owner: analysis.repository.owner,
    name: analysis.repository.repo,
    commitSha: analysis.repository.commitSha,
  },
  frontendSourceRoot: analysis.target.sourceRoot,
  backendSourceRoot: databaseBackend.sourceRoot,
  status: "queued",
  url: null,
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z",
  expiresAt: "2026-10-08T00:15:00.000Z",
}

const session = {
  token: "peephole-session",
  expiresAt: "2099-01-01T00:00:00.000Z",
}

describe("FullStackPreviewPanel", () => {
  const roots: Root[] = []

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(queued.createdAt))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    for (const root of roots) act(() => root.unmount())
    roots.length = 0
    document.body.innerHTML = ""
  })

  it("submits the exact frontend/backend pair even when backend-v1 rejects its database requirement", async () => {
    const api = createApi({ create: vi.fn().mockResolvedValue(queued) })
    const container = await renderPanel(api, roots)

    expect(
      Array.from(
        container.querySelectorAll("code"),
        (node) => node.textContent,
      ),
    ).toEqual([".", "backend"])

    await act(async () =>
      getButton(container, "Run full-stack preview").click(),
    )

    expect(api.create).toHaveBeenCalledWith(
      {
        contractVersion: "fullstack-v1",
        repository: queued.repository,
        frontendTarget: { sourceRoot: "." },
        backendSourceRoot: "backend",
      },
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        idempotencyKey: expect.stringMatching(/^fullstack-request-/),
      }),
    )
    expect(container.textContent).toContain("Queued")
  })

  it("requires an explicit backend selection when multiple candidates exist", async () => {
    const api = createApi()
    const second = { ...databaseBackend, sourceRoot: "services/api" }
    const container = await renderPanel(
      api,
      roots,
      createAnalysis([databaseBackend, second]),
    )

    expect(container.textContent).toContain("Choose an explicit backend target")
    expect(findButton(container, "Run full-stack preview")).toBeUndefined()

    const select = container.querySelector<HTMLSelectElement>(
      'select[name="fullstack-backend-target"]',
    )!
    await act(async () => {
      setSelectValue(select, "services/api")
    })
    await act(async () =>
      getButton(container, "Run full-stack preview").click(),
    )

    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ backendSourceRoot: "services/api" }),
      expect.anything(),
    )
  })

  it("locks backend selection during create and keeps control of the active job", async () => {
    let resolveCreate!: (preview: FullStackPreview) => void
    const create = vi.fn(
      () =>
        new Promise<FullStackPreview>((resolve) => {
          resolveCreate = resolve
        }),
    )
    const api = createApi({ create })
    const second = { ...databaseBackend, sourceRoot: "services/api" }
    const container = await renderPanel(
      api,
      roots,
      createAnalysis([databaseBackend, second]),
    )
    const select = container.querySelector<HTMLSelectElement>(
      'select[name="fullstack-backend-target"]',
    )!

    await act(async () => setSelectValue(select, "backend"))
    await act(async () =>
      getButton(container, "Run full-stack preview").click(),
    )

    expect(select.disabled).toBe(true)
    await act(async () => setSelectValue(select, "services/api"))
    await act(async () => resolveCreate(queued))

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ backendSourceRoot: "backend" }),
      expect.anything(),
    )
    expect(container.textContent).toContain(queued.id)
    await act(async () =>
      getButton(container, "Cancel full-stack preview").click(),
    )
    expect(api.stop).toHaveBeenCalledWith(queued.id, expect.anything())
  })

  it("does not offer execution for an unsupported frontend or missing backend", async () => {
    const unsupportedFrontend = {
      ...analysis,
      preview: { ...analysis.preview, mode: "unsupported" as const },
    }
    const frontendContainer = await renderPanel(
      createApi(),
      roots,
      unsupportedFrontend,
    )
    expect(frontendContainer.textContent).toContain(
      "selected frontend does not qualify",
    )
    expect(
      findButton(frontendContainer, "Run full-stack preview"),
    ).toBeUndefined()

    const backendContainer = await renderPanel(
      createApi(),
      roots,
      createAnalysis([]),
    )
    expect(backendContainer.textContent).toContain(
      "No backend candidate was detected",
    )
    expect(
      findButton(backendContainer, "Run full-stack preview"),
    ).toBeUndefined()
  })

  it("explains an obviously unsupported backend without offering Run", async () => {
    const unsupportedBackend: BackendCandidate = {
      ...databaseBackend,
      framework: "fastify",
      databaseDependencies: [],
      environmentRequirements: [],
    }
    const container = await renderPanel(
      createApi(),
      roots,
      createAnalysis([unsupportedBackend]),
    )

    expect(container.textContent).toContain(
      "fastify execution is not supported yet",
    )
    expect(container.textContent).toContain(
      "No detected backend candidate matches the narrow fullstack-v1 shape",
    )
    expect(findButton(container, "Run full-stack preview")).toBeUndefined()
  })

  it("polls to ready, embeds only the approved origin, then stops", async () => {
    vi.useFakeTimers()
    const ready: FullStackPreview = {
      ...queued,
      status: "ready",
      url: `https://${queued.id}.preview.example/`,
    }
    const stopped: FullStackPreview = { ...ready, status: "stopped" }
    const api = createApi({
      create: vi.fn().mockResolvedValue(queued),
      get: vi.fn().mockResolvedValue(ready),
      stop: vi.fn().mockResolvedValue(stopped),
    })
    const container = await renderPanel(api, roots, analysis, 10)

    await act(async () =>
      getButton(container, "Run full-stack preview").click(),
    )
    await act(async () => vi.advanceTimersByTimeAsync(10))

    const iframe = container.querySelector("iframe")
    expect(iframe?.getAttribute("src")).toBe(ready.url)
    expect(iframe?.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin allow-forms",
    )
    expect(iframe?.getAttribute("title")).toBe("Peephole full-stack preview")

    await act(async () =>
      getButton(container, "Stop full-stack preview").click(),
    )
    expect(api.stop).toHaveBeenCalledWith(
      queued.id,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(container.querySelector("iframe")).toBeNull()
    expect(container.textContent).toContain("Full-stack preview stopped")
  })

  it("blocks an untrusted ready URL", async () => {
    const api = createApi({
      create: vi.fn().mockResolvedValue({
        ...queued,
        status: "ready",
        url: "https://attacker.example/",
      }),
    })
    const container = await renderPanel(api, roots)
    await act(async () =>
      getButton(container, "Run full-stack preview").click(),
    )

    expect(container.querySelector("iframe")).toBeNull()
    expect(container.textContent).toContain("not approved for embedding")
  })

  it("blocks a trusted-origin URL whose full-stack ID does not match", async () => {
    const otherId = "fullstack-87654321-4321-4321-4321-cba987654321"
    const api = createApi({
      create: vi.fn().mockResolvedValue({
        ...queued,
        status: "ready",
        url: `https://${otherId}.preview.example/`,
      }),
    })
    const container = await renderPanel(api, roots)
    await act(async () =>
      getButton(container, "Run full-stack preview").click(),
    )

    expect(container.querySelector("iframe")).toBeNull()
    expect(container.textContent).toContain("not approved for embedding")
  })

  it("removes a ready iframe when its server-provided expiry passes locally", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse(queued.createdAt))
    const ready: FullStackPreview = {
      ...queued,
      status: "ready",
      url: `https://${queued.id}.preview.example/`,
      expiresAt: "2026-10-08T00:00:00.050Z",
    }
    const container = await renderPanel(
      createApi({ create: vi.fn().mockResolvedValue(ready) }),
      roots,
      analysis,
      1_000,
    )
    await act(async () =>
      getButton(container, "Run full-stack preview").click(),
    )
    expect(container.querySelector("iframe")).not.toBeNull()

    await act(async () => vi.advanceTimersByTimeAsync(50))

    expect(container.querySelector("iframe")).toBeNull()
    expect(container.querySelector('a[target="_blank"]')).toBeNull()
    expect(container.textContent).toContain("Preview access expired locally")
    expect(container.textContent).toContain("Server status")
  })

  it("hides an expired ready preview even after polling fails", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse(queued.createdAt))
    const ready: FullStackPreview = {
      ...queued,
      status: "ready",
      url: `https://${queued.id}.preview.example/`,
      expiresAt: "2026-10-08T00:00:00.050Z",
    }
    const api = createApi({
      create: vi.fn().mockResolvedValue(ready),
      get: vi.fn().mockRejectedValue(new Error("poll unavailable")),
    })
    const container = await renderPanel(api, roots, analysis, 10)
    await act(async () =>
      getButton(container, "Run full-stack preview").click(),
    )
    expect(container.querySelector("iframe")).not.toBeNull()

    await act(async () => vi.advanceTimersByTimeAsync(10))
    expect(container.textContent).toContain("poll unavailable")
    await act(async () => vi.advanceTimersByTimeAsync(40))

    expect(container.querySelector("iframe")).toBeNull()
    expect(container.querySelector('a[target="_blank"]')).toBeNull()
    expect(container.textContent).toContain(
      "Preview access has expired based on the server-provided time",
    )
    expect(findButton(container, "Stop full-stack preview")).toBeDefined()
  })

  it("removes a ready iframe when the server reports expiry", async () => {
    vi.useFakeTimers()
    const ready: FullStackPreview = {
      ...queued,
      status: "ready",
      url: `https://${queued.id}.preview.example/`,
    }
    const api = createApi({
      create: vi.fn().mockResolvedValue(ready),
      get: vi.fn().mockResolvedValue({ ...ready, status: "expired" }),
    })
    const container = await renderPanel(api, roots, analysis, 10)
    await act(async () =>
      getButton(container, "Run full-stack preview").click(),
    )
    expect(container.querySelector("iframe")).not.toBeNull()

    await act(async () => vi.advanceTimersByTimeAsync(10))
    expect(container.querySelector("iframe")).toBeNull()
    expect(container.textContent).toContain("Full-stack preview expired")
  })

  it("reuses one idempotency key for a retried create request", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(queued)
    const container = await renderPanel(createApi({ create }), roots)

    await act(async () =>
      getButton(container, "Run full-stack preview").click(),
    )
    await act(async () => getButton(container, "Retry").click())

    const firstKey = create.mock.calls[0]?.[1]?.idempotencyKey
    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[1]?.[1]?.idempotencyKey).toBe(firstKey)
  })

  it("ignores a rapid duplicate create click", async () => {
    const create = vi.fn(() => new Promise<FullStackPreview>(() => undefined))
    const container = await renderPanel(createApi({ create }), roots)
    const button = getButton(container, "Run full-stack preview")

    await act(async () => {
      button.click()
      button.click()
    })

    expect(create).toHaveBeenCalledOnce()
  })

  it("aborts a stale request when the selected branch commit changes", async () => {
    let firstSignal: AbortSignal | undefined
    const api = createApi({
      create: vi.fn((_request, options) => {
        firstSignal = options?.signal
        return new Promise<FullStackPreview>(() => undefined)
      }),
    })
    const { container, root } = await renderPanelWithRoot(api, roots, analysis)
    await act(async () =>
      getButton(container, "Run full-stack preview").click(),
    )

    const nextAnalysis = {
      ...analysis,
      repository: {
        ...analysis.repository,
        commitSha: "abcdef0123456789abcdef0123456789abcdef01",
      },
    }
    await act(async () => {
      root.render(
        <FullStackPreviewPanel
          analysis={nextAnalysis}
          fullStackPreviewApi={api}
          getSession={() => Promise.resolve(session)}
          previewArtifactBaseDomain="preview.example"
        />,
      )
    })

    expect(firstSignal?.aborted).toBe(true)
    expect(container.textContent).toContain("Run full-stack preview")
  })

  it("retains an active preview across frontend and branch remounts", async () => {
    const api = createApi()
    const { container, root } = await renderRetainedPanelHarness(
      api,
      roots,
      analysis,
    )
    await act(async () =>
      getButton(container, "Run full-stack preview").click(),
    )
    expect(container.textContent).toContain(queued.id)

    const nextAnalysis = {
      ...analysis,
      repository: {
        ...analysis.repository,
        commitSha: "abcdef0123456789abcdef0123456789abcdef01",
      },
      target: { ...analysis.target, sourceRoot: "apps/web" },
    }
    await act(async () => {
      root.render(<RetainedPanelHarness analysis={nextAnalysis} api={api} />)
    })

    expect(container.textContent).toContain(queued.id)
    expect(container.textContent).toContain("previously started preview")
    await act(async () =>
      getButton(container, "Cancel full-stack preview").click(),
    )
    expect(api.stop).toHaveBeenCalledWith(queued.id, expect.anything())
  })

  it("reuses the GitHub reconnect flow when no valid session exists", async () => {
    const connectGitHub = vi.fn().mockResolvedValue(undefined)
    const container = await renderPanel(
      createApi(),
      roots,
      analysis,
      1_500,
      connectGitHub,
      () => Promise.resolve(null),
    )

    expect(container.textContent).toContain("Connect GitHub")
    await act(async () => getButton(container, "Connect GitHub").click())
    expect(connectGitHub).toHaveBeenCalledOnce()
    expect(container.textContent).toContain("Run full-stack preview")
  })
})

function createAnalysis(
  candidates: BackendCandidate[],
): BuildTargetAnalysis & RepositoryAnalysis {
  const repositoryAnalysis: RepositoryAnalysis = {
    ...supportedAnalysis,
    backend: {
      status: candidates.length > 0 ? "detected" : "not-detected",
      candidates,
      evidence: [],
      warnings: [],
      complete: true,
      truncated: false,
    },
  }
  return {
    ...repositoryAnalysis,
    ...toRootBuildTargetAnalysis(repositoryAnalysis),
  }
}

function createApi(
  overrides: Partial<FullStackPreviewApi> = {},
): FullStackPreviewApi {
  return {
    create: vi.fn().mockResolvedValue(queued),
    get: vi.fn().mockResolvedValue(queued),
    stop: vi.fn().mockResolvedValue({ ...queued, status: "cancelled" }),
    ...overrides,
  }
}

async function renderPanel(
  api: FullStackPreviewApi | null,
  roots: Root[],
  value = analysis,
  pollIntervalMs = 1_500,
  connectGitHub: (() => Promise<void>) | null = vi
    .fn()
    .mockResolvedValue(undefined),
  getSession: () => Promise<typeof session | null> = () =>
    Promise.resolve(session),
): Promise<HTMLDivElement> {
  return (
    await renderPanelWithRoot(
      api,
      roots,
      value,
      pollIntervalMs,
      connectGitHub,
      getSession,
    )
  ).container
}

async function renderPanelWithRoot(
  api: FullStackPreviewApi | null,
  roots: Root[],
  value = analysis,
  pollIntervalMs = 1_500,
  connectGitHub: (() => Promise<void>) | null = vi
    .fn()
    .mockResolvedValue(undefined),
  getSession: () => Promise<typeof session | null> = () =>
    Promise.resolve(session),
): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <FullStackPreviewPanel
        analysis={value}
        connectGitHub={connectGitHub}
        fullStackPreviewApi={api}
        getSession={getSession}
        pollIntervalMs={pollIntervalMs}
        previewArtifactBaseDomain="preview.example"
      />,
    )
  })
  return { container, root }
}

function RetainedPanelHarness({
  analysis: value,
  api,
}: {
  analysis: BuildTargetAnalysis & RepositoryAnalysis
  api: FullStackPreviewApi
}) {
  const [retainedPreview, setRetainedPreview] =
    useState<FullStackPreview | null>(null)
  return (
    <FullStackPreviewPanel
      analysis={value}
      fullStackPreviewApi={api}
      getSession={() => Promise.resolve(session)}
      key={`${value.repository.commitSha}:${value.target.sourceRoot}`}
      onRetainedPreviewChange={setRetainedPreview}
      previewArtifactBaseDomain="preview.example"
      retainedPreview={retainedPreview}
    />
  )
}

async function renderRetainedPanelHarness(
  api: FullStackPreviewApi,
  roots: Root[],
  value: BuildTargetAnalysis & RepositoryAnalysis,
): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<RetainedPanelHarness analysis={value} api={api} />)
  })
  return { container, root }
}

function findButton(
  container: HTMLElement,
  label: string,
): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(label),
  )
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = findButton(container, label)
  if (!button) throw new Error(`Button not found: ${label}`)
  return button
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )
  descriptor?.set?.call(select, value)
  select.dispatchEvent(new Event("change", { bubbles: true }))
}
