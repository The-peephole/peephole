// @vitest-environment jsdom

import { act, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SidePanelApp } from "../entrypoints/sidepanel/App"
import {
  createTabFullStackControlStore,
  type RetainedFullStackControl,
} from "../core/sidepanel/fullStackRetention"
import { createNavigationBarrier } from "../core/sidepanel/navigationBarrier"
import { createSidePanelNavigation } from "../core/sidepanel/navigation"
import type { FullStackPreviewApi } from "../core/fullstack/apiClient"
import type { PreviewApi } from "../core/preview/apiClient"
import type {
  BuildTargetAnalysis,
  BuildTargetAnalysisLoader,
  RepositoryAnalysis,
  RepositoryAnalysisLoader,
} from "../types/analysis"
import type { BackendCandidate } from "../types/backend"
import type { FullStackPreview } from "../types/fullstackPreview"
import { supportedAnalysis } from "./analysisFixture"

vi.mock("../core/preview/sessionStorage", () => ({
  clearStoredPreviewSession: vi.fn().mockResolvedValue(undefined),
  getStoredPreviewSession: vi.fn().mockResolvedValue({
    token: "test-session",
    expiresAt: "2099-01-01T00:00:00.000Z",
  }),
}))

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

describe("SidePanelApp full-stack retention", () => {
  const roots: Root[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const root of roots) act(() => root.unmount())
    roots.length = 0
    document.body.innerHTML = ""
  })

  it.each([false, true])(
    "keeps one native Build card across ten root/frontend round trips (StrictMode %s)",
    async (strict) => {
      const analysis = createRootAnalysis()
      const errors = vi.spyOn(console, "error")
      const previewApi = { create: vi.fn(), get: vi.fn(), cancel: vi.fn() }
      const container = await renderSidePanel({
        analysisForBranch: () => analysis,
        api: createApi(),
        loadTarget: async (_repository, target) =>
          createTargetAnalysis(analysis, target.sourceRoot),
        roots,
        strict,
        previewApi,
      })
      const select = getSelect(container, "preview-target")
      for (let cycle = 0; cycle < 10; cycle++) {
        await act(async () => setSelectValue(select, "frontend"))
        expect(
          container.querySelectorAll(".peephole__preview-action"),
        ).toHaveLength(1)
        expect(container.textContent).toContain("Native preview compatible")
        const oldButton = getButton(container, "Build preview")
        expect(oldButton.disabled).toBe(false)
        await act(async () => setSelectValue(select, "."))
        expect(
          container.querySelectorAll(".peephole__preview-action"),
        ).toHaveLength(0)
        expect(container.textContent).toContain("Native preview blocked")
        expect(oldButton.isConnected).toBe(false)
        await act(async () => oldButton.click())
        expect(container.querySelectorAll(".peephole-panel")).toHaveLength(1)
        expect(document.querySelectorAll("#root")).toHaveLength(1)
        expect(container.querySelectorAll(".peephole__analysis")).toHaveLength(
          1,
        )
      }
      expect(previewApi.create).not.toHaveBeenCalled()
      expect(errors).not.toHaveBeenCalled()
    },
  )

  it("ignores slow target replies after rapid target changes", async () => {
    const analysis = createRootAnalysis()
    const replies: ReturnType<typeof createDeferred<BuildTargetAnalysis>>[] = []
    const signals: (AbortSignal | undefined)[] = []
    let slow = false
    const previewApi = { create: vi.fn(), get: vi.fn(), cancel: vi.fn() }
    const container = await renderSidePanel({
      analysisForBranch: () => analysis,
      api: createApi(),
      roots,
      previewApi,
      loadTarget: async (_repository, target, options) => {
        if (!slow) return createTargetAnalysis(analysis, target.sourceRoot)
        const reply = createDeferred<BuildTargetAnalysis>()
        replies.push(reply)
        signals.push(options?.signal)
        return reply.promise
      },
    })
    slow = true
    const target = getSelect(container, "preview-target")
    await act(async () => setSelectValue(target, "frontend"))
    expect(
      container.querySelectorAll(".peephole__preview-action"),
    ).toHaveLength(0)
    expect(container.textContent).toContain(
      "Inspecting selected preview target",
    )
    await act(async () => setSelectValue(target, "."))
    expect(signals[0]?.aborted).toBe(true)
    await act(async () => setSelectValue(target, "frontend"))
    const latest = replies.at(-1)!
    await act(async () =>
      latest.resolve(createTargetAnalysis(analysis, "frontend")),
    )
    expect(
      container.querySelectorAll(".peephole__preview-action"),
    ).toHaveLength(1)
    await act(async () => {
      for (const reply of replies.slice(0, -1))
        reply.resolve({
          ...createTargetAnalysis(analysis, "frontend"),
          warnings: ["STALE TARGET"],
        })
    })
    expect(container.textContent).not.toContain("STALE TARGET")
    await act(async () => setSelectValue(target, "."))
    expect(
      container.querySelectorAll(".peephole__preview-action"),
    ).toHaveLength(0)
    expect(previewApi.create).not.toHaveBeenCalled()
  })

  it("ignores an old branch reply and hides inactive analysis details while loading", async () => {
    const main = createRootAnalysis({ commitSha: "1".repeat(40) })
    const feature = createRootAnalysis({ commitSha: "2".repeat(40) })
    const reply = createDeferred<RepositoryAnalysis>()
    const container = await renderSidePanel({
      analysisForBranch: (branch) =>
        branch === "feature" ? reply.promise : main,
      api: createApi(),
      roots,
      branches: ["main", "feature"],
      loadTarget: async (_repository, target) =>
        createTargetAnalysis(main, target.sourceRoot),
    })
    await act(async () =>
      setSelectValue(getSelect(container, "branch"), "feature"),
    )
    expect(
      container.querySelector<HTMLDivElement>(
        ".peephole__analysis-details-content",
      )?.hidden,
    ).toBe(true)
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent === "Run full-stack preview",
      ),
    ).toBe(false)
    await act(async () =>
      setSelectValue(getSelect(container, "branch"), "main"),
    )
    await act(async () => reply.resolve(feature))
    expect(getSelect(container, "branch").value).toBe("main")
    expect(container.textContent).toContain(
      main.repository.commitSha.slice(0, 7),
    )
    expect(container.textContent).not.toContain(
      feature.repository.commitSha.slice(0, 7),
    )
    expect(
      container.querySelector<HTMLDivElement>(
        ".peephole__analysis-details-content",
      )?.hidden,
    ).toBe(false)
  })

  it("keeps the same workspace and ready iframe between discovery and details through branch/target changes", async () => {
    const main = createRootAnalysis()
    const feature = createRootAnalysis({ commitSha: "2".repeat(40) })
    const ready: FullStackPreview = {
      ...createPreview(main),
      status: "ready",
      url: `https://${createPreview(main).id}.preview.example.test/`,
      expiresAt: "2099-01-01T00:00:00.000Z",
    }
    const api = createApi({
      create: vi.fn().mockResolvedValue(ready),
      stop: vi
        .fn()
        .mockResolvedValue({ ...ready, status: "stopped", url: null }),
      get: vi.fn().mockResolvedValue(ready),
    })
    const container = await renderSidePanel({
      analysisForBranch: (branch) => (branch === "feature" ? feature : main),
      api,
      roots,
      strict: true,
      branches: ["main", "feature"],
      loadTarget: async (repository, target) =>
        createTargetAnalysis(
          repository.commitSha === feature.repository.commitSha
            ? feature
            : main,
          target.sourceRoot,
        ),
    })
    const panel = container.querySelector(".peephole__fullstack")!
    const labelId = panel.getAttribute("aria-labelledby")
    const assertPosition = () => {
      expect(container.querySelector(".peephole__fullstack")).toBe(panel)
      expect(panel.getAttribute("aria-labelledby")).toBe(labelId)
      expect(panel.parentElement?.className).toBe("peephole-panel")
      expect(
        panel.compareDocumentPosition(
          container.querySelector(".peephole__analysis")!,
        ) & Node.DOCUMENT_POSITION_PRECEDING,
      ).toBeTruthy()
      expect(
        panel.compareDocumentPosition(
          container.querySelector(".peephole__analysis-details")!,
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    }
    assertPosition()
    await act(async () =>
      getButton(container, "Run full-stack preview").click(),
    )
    assertPosition()
    const iframe = panel.querySelector("iframe")!
    expect(iframe).toBeTruthy()
    iframe.dataset.retainedState = "preserved"
    await act(async () =>
      setSelectValue(getSelect(container, "preview-target"), "frontend"),
    )
    assertPosition()
    expect(panel.querySelector("iframe")).toBe(iframe)
    await act(async () =>
      setSelectValue(getSelect(container, "branch"), "feature"),
    )
    assertPosition()
    expect(panel.querySelector("iframe")).toBe(iframe)
    expect(iframe.dataset.retainedState).toBe("preserved")
    expect(iframe.getAttribute("src")).toBe(ready.url)
    await act(async () =>
      getButton(container, "Stop full-stack preview").click(),
    )
    expect(api.stop).toHaveBeenCalledWith(
      ready.id,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(api.create).toHaveBeenCalledTimes(1)
  })

  it("keeps the create request and active job attached when the frontend changes", async () => {
    const analysis = createRootAnalysis({
      frontendRoots: ["frontend", "apps/admin"],
    })
    const pendingCreate = createDeferred<FullStackPreview>()
    let createSignal: AbortSignal | undefined
    const api = createApi({
      create: vi.fn((_request, options) => {
        createSignal = options?.signal
        return pendingCreate.promise
      }),
    })
    const container = await renderSidePanel({
      analysisForBranch: () => analysis,
      api,
      loadTarget: async (_repository, target) =>
        createTargetAnalysis(analysis, target.sourceRoot),
      roots,
    })
    const select = getSelect(container, "fullstack-frontend-target")

    await act(async () => setSelectValue(select, "frontend"))
    await act(async () =>
      getButton(container, "Run full-stack preview").click(),
    )

    expect(select.disabled).toBe(true)
    await act(async () => setSelectValue(select, "apps/admin"))
    expect(select.value).toBe("frontend")
    expect(createSignal?.aborted).toBe(false)

    const queued = createPreview(analysis)
    await act(async () => pendingCreate.resolve(queued))

    expect(createSignal?.aborted).toBe(false)
    expect(container.querySelectorAll(".peephole__fullstack")).toHaveLength(1)
    const activeControls = container.querySelector(".peephole__fullstack")
    expect(activeControls?.textContent).toContain(queued.id)
    expect(activeControls?.textContent).toContain("frontend")
    expect(activeControls?.textContent).toContain(
      analysis.repository.commitSha.slice(0, 7),
    )

    await act(async () => setSelectValue(select, "apps/admin"))
    expect(select.value).toBe("apps/admin")
    expect(activeControls?.textContent).toContain(queued.id)
    expect(activeControls?.textContent).toContain("frontend")
    expect(api.create).toHaveBeenCalledTimes(1)
  })

  it("keeps Stop access through another branch's discovery loading and error states", async () => {
    const main = createRootAnalysis({ commitSha: "1".repeat(40) })
    const feature = createRootAnalysis({ commitSha: "2".repeat(40) })
    const pendingFeatureTarget = createDeferred<BuildTargetAnalysis>()
    const queued = createPreview(main)
    const api = createApi({
      create: vi.fn().mockResolvedValue(queued),
      stop: vi.fn().mockResolvedValue({ ...queued, status: "stopped" }),
    })
    const container = await renderSidePanel({
      analysisForBranch: (branch) => (branch === "feature" ? feature : main),
      api,
      branches: ["main", "feature"],
      loadTarget: async (repository, target) => {
        if (repository.commitSha === feature.repository.commitSha) {
          return pendingFeatureTarget.promise
        }
        return createTargetAnalysis(main, target.sourceRoot)
      },
      roots,
    })

    await act(async () =>
      getButton(container, "Run full-stack preview").click(),
    )
    expect(getButton(container, "Cancel full-stack preview")).toBeTruthy()

    await act(async () =>
      setSelectValue(getSelect(container, "branch"), "feature"),
    )
    expect(container.textContent).toContain(
      "Inspecting nested frontend candidates for full-stack preview",
    )
    expect(getButton(container, "Cancel full-stack preview")).toBeTruthy()
    expect(container.textContent).toContain(
      main.repository.commitSha.slice(0, 7),
    )

    await act(async () =>
      pendingFeatureTarget.reject(new Error("Target analysis unavailable.")),
    )
    expect(container.textContent).toContain("Target analysis unavailable.")
    expect(getButton(container, "Cancel full-stack preview")).toBeTruthy()

    await act(async () =>
      getButton(container, "Cancel full-stack preview").click(),
    )
    expect(api.stop).toHaveBeenCalledWith(
      queued.id,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it("keeps the exact active job when the selected branch has no frontend", async () => {
    const main = createRootAnalysis({ commitSha: "3".repeat(40) })
    const noFrontend = createRootAnalysis({
      commitSha: "4".repeat(40),
      frontendRoots: [],
    })
    const queued = createPreview(main)
    const api = createApi({ create: vi.fn().mockResolvedValue(queued) })
    const container = await renderSidePanel({
      analysisForBranch: (branch) =>
        branch === "no-frontend" ? noFrontend : main,
      api,
      branches: ["main", "no-frontend"],
      loadTarget: async (repository, target) =>
        createTargetAnalysis(
          repository.commitSha === main.repository.commitSha
            ? main
            : noFrontend,
          target.sourceRoot,
        ),
      roots,
    })

    await act(async () =>
      getButton(container, "Run full-stack preview").click(),
    )
    await act(async () =>
      setSelectValue(getSelect(container, "branch"), "no-frontend"),
    )

    expect(container.textContent).toContain(
      "No nested full-stack application detected",
    )
    expect(getButton(container, "Cancel full-stack preview")).toBeTruthy()
    const activeControls = container.querySelector(".peephole__fullstack")
    expect(activeControls?.textContent).toContain(queued.id)
    expect(activeControls?.textContent).toContain("frontend")
    expect(activeControls?.textContent).toContain(
      main.repository.commitSha.slice(0, 7),
    )
    expect(activeControls?.textContent).not.toContain(
      noFrontend.repository.commitSha.slice(0, 7),
    )
  })

  it("locks the branch selector until a pending root create returns its job ID", async () => {
    const main = createRootAnalysis({ commitSha: "5".repeat(40) })
    const feature = createRootAnalysis({ commitSha: "6".repeat(40) })
    const pendingCreate = createDeferred<FullStackPreview>()
    let createSignal: AbortSignal | undefined
    const api = createApi({
      create: vi.fn((_request, options) => {
        createSignal = options?.signal
        return pendingCreate.promise
      }),
    })
    const container = await renderSidePanel({
      analysisForBranch: (branch) => (branch === "feature" ? feature : main),
      api,
      branches: ["main", "feature"],
      loadTarget: async (repository, target) =>
        createTargetAnalysis(
          repository.commitSha === main.repository.commitSha ? main : feature,
          target.sourceRoot,
        ),
      roots,
    })
    const branch = getSelect(container, "branch")

    await act(async () =>
      getButton(container, "Run full-stack preview").click(),
    )
    expect(branch.disabled).toBe(true)
    await act(async () => setSelectValue(branch, "feature"))
    expect(container.textContent).not.toContain(
      feature.repository.commitSha.slice(0, 7),
    )
    expect(createSignal?.aborted).toBe(false)

    const queued = createPreview(main)
    await act(async () => pendingCreate.resolve(queued))
    expect(createSignal?.aborted).toBe(false)
    expect(getSelect(container, "branch").disabled).toBe(false)

    await act(async () =>
      setSelectValue(getSelect(container, "branch"), "feature"),
    )
    expect(container.textContent).toContain(
      feature.repository.commitSha.slice(0, 7),
    )
    const activeControls = container.querySelector(".peephole__fullstack")
    expect(activeControls?.textContent).toContain(queued.id)
    expect(activeControls?.textContent).toContain(
      main.repository.commitSha.slice(0, 7),
    )
    expect(getButton(container, "Cancel full-stack preview")).toBeTruthy()
    expect(container.textContent).not.toContain("Run full-stack preview")
    expect(api.create).toHaveBeenCalledTimes(1)
  })

  it("unlocks the branch selector after a pending create fails", async () => {
    const analysis = createRootAnalysis({ commitSha: "7".repeat(40) })
    const pendingCreate = createDeferred<FullStackPreview>()
    const api = createApi({ create: vi.fn(() => pendingCreate.promise) })
    const container = await renderSidePanel({
      analysisForBranch: () => analysis,
      api,
      branches: ["main", "feature"],
      loadTarget: async (_repository, target) =>
        createTargetAnalysis(analysis, target.sourceRoot),
      roots,
    })

    await act(async () =>
      getButton(container, "Run full-stack preview").click(),
    )
    expect(getSelect(container, "branch").disabled).toBe(true)

    await act(async () =>
      pendingCreate.reject(new Error("Full-stack admission failed.")),
    )
    expect(container.textContent).toContain("Full-stack admission failed.")
    expect(getSelect(container, "branch").disabled).toBe(false)
    expect(api.create).toHaveBeenCalledTimes(1)
  })

  it("locks branch and target selectors while a nested-target create is pending", async () => {
    const analysis = createRootAnalysis({ commitSha: "8".repeat(40) })
    const pendingCreate = createDeferred<FullStackPreview>()
    let createSignal: AbortSignal | undefined
    const api = createApi({
      create: vi.fn((_request, options) => {
        createSignal = options?.signal
        return pendingCreate.promise
      }),
    })
    const container = await renderSidePanel({
      analysisForBranch: () => analysis,
      api,
      branches: ["main", "feature"],
      loadTarget: async (_repository, target) =>
        createTargetAnalysis(analysis, target.sourceRoot),
      roots,
    })
    const target = getSelect(container, "preview-target")

    await act(async () => setSelectValue(target, "frontend"))
    await act(async () =>
      getButton(container, "Run full-stack preview").click(),
    )
    expect(target.disabled).toBe(true)
    expect(getSelect(container, "branch").disabled).toBe(true)
    await act(async () => setSelectValue(target, "."))
    expect(target.value).toBe("frontend")
    expect(createSignal?.aborted).toBe(false)

    const queued = createPreview(analysis)
    await act(async () => pendingCreate.resolve(queued))
    expect(target.disabled).toBe(false)
    expect(getSelect(container, "branch").disabled).toBe(false)
    expect(
      container.querySelector(".peephole__fullstack")?.textContent,
    ).toContain(queued.id)
    expect(api.create).toHaveBeenCalledTimes(1)
  })
})

function createApi(
  overrides: Partial<FullStackPreviewApi> = {},
): FullStackPreviewApi {
  const unavailable = () => Promise.reject(new Error("Unexpected API call"))
  return {
    create: overrides.create ?? unavailable,
    get: overrides.get ?? unavailable,
    stop: overrides.stop ?? unavailable,
  }
}

async function renderSidePanel({
  analysisForBranch,
  api,
  branches = ["main"],
  loadTarget,
  roots,
  strict = false,
  previewApi = null,
  initial = null,
  persist,
  onCreatePending,
  repository = { owner: "The-peephole", repo: "peephole-fixture-fullstack" },
}: {
  analysisForBranch: (
    branch: string,
  ) => RepositoryAnalysis | Promise<RepositoryAnalysis>
  api: FullStackPreviewApi
  branches?: string[]
  loadTarget: BuildTargetAnalysisLoader
  roots: Root[]
  strict?: boolean
  previewApi?: PreviewApi | null
  initial?: RetainedFullStackControl | null
  persist?: (control: RetainedFullStackControl | null) => Promise<void>
  onCreatePending?: (pending: boolean) => void
  repository?: { owner: string; repo: string }
}): Promise<HTMLDivElement> {
  const container = document.createElement("div")
  container.id = "root"
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  const loadRepositoryAnalysis = vi.fn<RepositoryAnalysisLoader>(
    async ({ ref }) =>
      analysisForBranch(ref.kind === "branch" ? ref.name : "main"),
  )

  await act(async () => {
    const app = (
      <SidePanelApp
        fullStackPreviewApi={api}
        fullStackPreviewEnabled
        initialFullStackControl={initial}
        persistFullStackControl={persist}
        onCreatePendingChange={onCreatePending}
        loadBuildTargetAnalysis={loadTarget}
        loadRepositoryAnalysis={loadRepositoryAnalysis}
        loadRepositoryBranches={() =>
          Promise.resolve({
            defaultBranch: "main",
            branches,
            truncated: false,
          })
        }
        loadRepositoryLiveDeployment={() =>
          Promise.resolve({
            status: "not-detected",
            candidate: null,
            candidateCount: 0,
            truncated: false,
            evidence: [],
          })
        }
        previewApi={previewApi}
        previewArtifactBaseDomain="preview.example.test"
        repository={repository}
      />
    )
    root.render(strict ? <StrictMode>{app}</StrictMode> : app)
  })
  return container
}

function createRootAnalysis(
  options: { frontendRoots?: string[]; commitSha?: string } = {},
): RepositoryAnalysis {
  const frontendRoots = options.frontendRoots ?? ["frontend"]
  const repository = {
    ...supportedAnalysis.repository,
    owner: "The-peephole",
    repo: "peephole-fixture-fullstack",
    commitSha: options.commitSha ?? "3e5e914".padEnd(40, "0"),
  }
  return {
    ...supportedAnalysis,
    repository,
    technologies: { framework: "unknown", typescript: false, evidence: [] },
    preview: {
      ...supportedAnalysis.preview,
      mode: "unsupported",
      blockers: [
        {
          code: "UNSUPPORTED_FRAMEWORK",
          message: "Repository root is not a native static application.",
        },
      ],
    },
    structure: {
      layout: "multi-project",
      projects: [
        {
          path: ".",
          isRoot: true,
          role: "unknown",
          hasPackageJson: false,
          packageName: null,
          evidence: [],
          warnings: [],
        },
        ...frontendRoots.map((path) => ({
          path,
          isRoot: false,
          role: "project-candidate" as const,
          hasPackageJson: true,
          packageName: null,
          evidence: [],
          warnings: [],
        })),
        {
          path: databaseBackend.sourceRoot,
          isRoot: false,
          role: "project-candidate" as const,
          hasPackageJson: true,
          packageName: databaseBackend.packageName,
          evidence: [],
          warnings: [],
        },
      ],
      workspaceEvidence: [],
      warnings: [],
      complete: true,
      truncated: false,
    },
    backend: {
      status: "detected",
      candidates: [databaseBackend],
      evidence: [],
      warnings: [],
      complete: true,
      truncated: false,
    },
  }
}

function createTargetAnalysis(
  analysis: RepositoryAnalysis,
  sourceRoot: string,
): BuildTargetAnalysis {
  return {
    repository: analysis.repository,
    targetAnalyzerVersion: "test",
    target: { sourceRoot },
    technologies: {
      framework: "react-vite",
      typescript: true,
      evidence: ["vite and react dependencies detected"],
    },
    packageManager: "npm",
    runtime: supportedAnalysis.runtime,
    environment: supportedAnalysis.environment,
    environmentRequirements: [],
    preview: {
      ...supportedAnalysis.preview,
      contractVersion: "static-v2",
      mode: "native-static-build",
      blockers: [],
    },
    inspectedFiles: supportedAnalysis.inspectedFiles,
    warnings: [],
  }
}

function createPreview(analysis: RepositoryAnalysis): FullStackPreview {
  return {
    id: "fullstack-12345678-1234-1234-1234-123456789abc",
    repository: {
      repositoryId: analysis.repository.repositoryId,
      owner: analysis.repository.owner,
      name: analysis.repository.repo,
      commitSha: analysis.repository.commitSha,
    },
    frontendSourceRoot: "frontend",
    backendSourceRoot: "backend",
    status: "queued",
    url: null,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
    expiresAt: "2026-10-10T00:15:00.000Z",
  }
}

function createDeferred<T>(): {
  promise: Promise<T>
  reject: (reason: unknown) => void
  resolve: (value: T) => void
} {
  let reject!: (reason: unknown) => void
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, reject, resolve }
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )
  descriptor?.set?.call(select, value)
  select.dispatchEvent(new Event("change", { bubbles: true }))
}

function getSelect(container: HTMLElement, name: string): HTMLSelectElement {
  const select = container.querySelector<HTMLSelectElement>(
    `select[name="${name}"]`,
  )
  if (!select) throw new Error(`Select not found: ${name}`)
  return select
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.includes(label),
  )
  if (!button) throw new Error(`Button not found: ${label}`)
  return button
}

describe("Sidepanel navigation recovery", () => {
  const roots: Root[] = []
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    for (const root of roots) act(() => root.unmount())
    roots.length = 0
    document.body.innerHTML = ""
  })
  const loadTarget: BuildTargetAnalysisLoader = async (_, target) =>
    createTargetAnalysis(createRootAnalysis(), target.sourceRoot)
  it("rehydrates an admitted job across panel reload, names the original repository and stops without Create", async () => {
    const analysis = createRootAnalysis(),
      queued = createPreview(analysis)
    const store = createTabFullStackControlStore(17, createMemoryStorage())
    const api = createApi({ create: vi.fn().mockResolvedValue(queued) })
    const container = await renderSidePanel({
      analysisForBranch: () => analysis,
      api,
      roots,
      persist: store.save,
      loadTarget,
    })
    await act(async () =>
      getButton(container, "Run full-stack preview").click(),
    )
    const initial = await store.load()
    expect(initial?.preview.id).toBe(queued.id)
    await act(async () => roots.pop()!.unmount())
    container.remove()
    const stop = vi.fn().mockResolvedValue({ ...queued, status: "stopped" })
    const restoredApi = createApi({ create: vi.fn(), stop })
    const restored = await renderSidePanel({
      analysisForBranch: () => ({
        ...analysis,
        repository: { ...analysis.repository, repo: "another-repository" },
      }),
      api: restoredApi,
      roots,
      initial,
      persist: store.save,
      repository: { owner: "The-peephole", repo: "another-repository" },
      loadTarget,
    })
    expect(restored.textContent).toContain("Checking saved full-stack preview")
    expect(restored.textContent).toContain(
      "Full-stack controls: The-peephole/peephole-fixture-fullstack",
    )
    expect(restored.querySelector("iframe")).toBeNull()
    await act(async () =>
      getButton(restored, "Stop full-stack preview").click(),
    )
    expect(stop).toHaveBeenCalledWith(
      queued.id,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(restoredApi.create).not.toHaveBeenCalled()
    expect(api.create).toHaveBeenCalledTimes(1)
  })
  it("revalidates a saved ready preview before embedding; an expired server response cannot show an iframe", async () => {
    vi.useFakeTimers()
    const analysis = createRootAnalysis(),
      initial = {
        analysis: {
          ...analysis,
          ...createTargetAnalysis(analysis, "frontend"),
        },
        preview: {
          ...createPreview(analysis),
          status: "ready" as const,
          url: `https://${createPreview(analysis).id}.preview.example.test/`,
          expiresAt: "2099-01-01T00:00:00Z",
        },
      }
    const api = createApi({
      get: vi.fn().mockResolvedValue({
        ...initial.preview,
        status: "expired",
        url: null,
      }),
      create: vi.fn(),
    })
    const container = await renderSidePanel({
      analysisForBranch: () => analysis,
      api,
      roots,
      initial,
      loadTarget,
    })
    expect(container.querySelector("iframe")).toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(2000))
    expect(container.textContent).toContain("Full-stack preview expired")
    expect(container.querySelector("iframe")).toBeNull()
    expect(api.create).not.toHaveBeenCalled()
  })
  it("defers hiding until Create returns and saved controls are acknowledged", async () => {
    const analysis = createRootAnalysis(),
      queued = createPreview(analysis)
    const create = createDeferred<FullStackPreview>(),
      ack = createDeferred<void>()
    const store = createTabFullStackControlStore(17, {
      ...createMemoryStorage(),
      set: vi.fn(() => ack.promise),
    })
    const barrier = createNavigationBarrier(store)
    barrier.ready()
    const panelApi = {
      setOptions: vi.fn().mockResolvedValue(undefined),
      open: vi.fn(),
    }
    const nav = createSidePanelNavigation(panelApi, () => barrier.wait())
    const container = await renderSidePanel({
      analysisForBranch: () => analysis,
      api: createApi({ create: vi.fn(() => create.promise) }),
      roots,
      persist: barrier.save,
      onCreatePending: barrier.setCreating,
      loadTarget,
    })
    await act(async () =>
      getButton(container, "Run full-stack preview").click(),
    )
    const hide = nav.onUpdated(17, { status: "loading" })
    expect(panelApi.setOptions).not.toHaveBeenCalled()
    await act(async () => create.resolve(queued))
    expect(panelApi.setOptions).not.toHaveBeenCalled()
    await act(async () => ack.resolve())
    await hide
    expect(panelApi.setOptions).toHaveBeenCalledWith({
      tabId: 17,
      enabled: false,
    })
    expect(container.textContent).toContain(queued.id)
  })
  it("keeps admission retry controls visible after a lost Create response", async () => {
    const analysis = createRootAnalysis(),
      barrier = createNavigationBarrier(
        createTabFullStackControlStore(17, createMemoryStorage()),
      )
    barrier.ready()
    const container = await renderSidePanel({
      analysisForBranch: () => analysis,
      api: createApi({
        create: vi.fn().mockRejectedValue(new Error("Response lost")),
      }),
      roots,
      persist: barrier.save,
      onCreatePending: barrier.setCreating,
      loadTarget,
    })
    await act(async () =>
      getButton(container, "Run full-stack preview").click(),
    )
    let safe = false
    void barrier.wait().then(() => {
      safe = true
    })
    await act(async () => Promise.resolve())
    expect(safe).toBe(false)
    expect(getButton(container, "Retry")).toBeTruthy()
  })
  it("isolates snapshots by tab, rejects mismatched identities and excludes unrelated input/session fields", async () => {
    const analysis = createRootAnalysis(),
      control = {
        analysis: {
          ...analysis,
          ...createTargetAnalysis(analysis, "frontend"),
        },
        preview: createPreview(analysis),
      }
    const storage = createMemoryStorage(),
      a = createTabFullStackControlStore(17, storage),
      b = createTabFullStackControlStore(42, storage)
    const extra = {
      ...control,
      analysis: {
        ...control.analysis,
        environmentValues: { APP_GREETING: "DO_NOT_STORE" },
      },
      preview: {
        ...control.preview,
        userEnvironment: [{ name: "APP_GREETING", value: "DO_NOT_STORE" }],
      },
      userEnvironment: [{ name: "APP_GREETING", value: "DO_NOT_STORE" }],
      session: "DO_NOT_STORE",
    }
    await a.save(extra)
    expect(await b.load()).toBeNull()
    expect(JSON.stringify(storage.values)).not.toContain("DO_NOT_STORE")
    const first = createDeferred<void>(),
      order: string[] = []
    const ordered = createTabFullStackControlStore(17, {
      ...storage,
      set: async (item) => {
        const status = (Object.values(item)[0] as { preview: FullStackPreview })
          .preview.status
        order.push(status)
        if (status === "queued") await first.promise
      },
    })
    const earlier = ordered.save(control),
      later = ordered.save({
        ...control,
        preview: { ...control.preview, status: "stopped" },
      })
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(["queued"])
    first.resolve()
    await Promise.all([earlier, later])
    expect(order).toEqual(["queued", "stopped"])
    storage.values["peepholeFullStackControl:17"] = {
      version: 1,
      analysis: control.analysis,
      preview: {
        ...control.preview,
        repository: {
          ...control.preview.repository,
          commitSha: "f".repeat(40),
        },
      },
    }
    await expect(a.load()).rejects.toThrow("identity")
  })
  it("keeps Stop available and refuses hiding when persistence fails", async () => {
    const analysis = createRootAnalysis(),
      queued = createPreview(analysis),
      barrier = createNavigationBarrier(
        createTabFullStackControlStore(17, {
          ...createMemoryStorage(),
          set: async () => {
            throw new Error("Unavailable")
          },
        }),
      )
    barrier.ready()
    const api = createApi({ create: vi.fn().mockResolvedValue(queued) })
    const container = await renderSidePanel({
      analysisForBranch: () => analysis,
      api,
      roots,
      persist: barrier.save,
      onCreatePending: barrier.setCreating,
      loadTarget,
    })
    await act(async () =>
      getButton(container, "Run full-stack preview").click(),
    )
    expect(container.textContent).toContain(
      "Keep this panel open until you stop",
    )
    expect(getButton(container, "Cancel full-stack preview")).toBeTruthy()
    await expect(barrier.wait()).rejects.toThrow("not safe")
    expect(api.create).toHaveBeenCalledTimes(1)
  })
})

function createMemoryStorage() {
  const values: Record<string, unknown> = {}
  return {
    values,
    get: async (key: string) => ({ [key]: values[key] }),
    set: async (items: Record<string, unknown>) => {
      Object.assign(values, structuredClone(items))
    },
    remove: async (key: string) => {
      delete values[key]
    },
  }
}
