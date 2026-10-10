// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SidePanelApp } from "../entrypoints/sidepanel/App"
import type { FullStackPreviewApi } from "../core/fullstack/apiClient"
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
}: {
  analysisForBranch: (branch: string) => RepositoryAnalysis
  api: FullStackPreviewApi
  branches?: string[]
  loadTarget: BuildTargetAnalysisLoader
  roots: Root[]
}): Promise<HTMLDivElement> {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  const loadRepositoryAnalysis = vi.fn<RepositoryAnalysisLoader>(
    async ({ ref }) =>
      analysisForBranch(ref.kind === "branch" ? ref.name : "main"),
  )

  await act(async () => {
    root.render(
      <SidePanelApp
        fullStackPreviewApi={api}
        fullStackPreviewEnabled
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
        previewApi={null}
        repository={{
          owner: "The-peephole",
          repo: "peephole-fixture-fullstack",
        }}
      />,
    )
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
