// @vitest-environment jsdom

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { FullStackPreviewPanel } from "../components/FullStackPreviewPanel"
import { RepositoryAnalysisView } from "../components/RepositoryAnalysisView"
import {
  RootFullStackDiscovery,
  type FullStackPreviewRenderOptions,
} from "../components/RootFullStackDiscovery"
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

describe("RootFullStackDiscovery", () => {
  const roots: Root[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const root of roots) act(() => root.unmount())
    roots.length = 0
    document.body.innerHTML = ""
  })

  it("discovers the unique nested frontend/backend pair while root static preview remains unavailable", async () => {
    const analysis = createRootAnalysis()
    const loadTarget = vi
      .fn<BuildTargetAnalysisLoader>()
      .mockResolvedValue(createTargetAnalysis(analysis, "frontend"))
    const container = await renderDiscovery(
      analysis,
      loadTarget,
      roots,
      (value) => (
        <span data-testid="discovered-target">{value.target.sourceRoot}</span>
      ),
    )

    expect(container.textContent).toContain("Full-stack application detected")
    expect(container.textContent).toContain(
      "Repository root remains unavailable for a native static preview",
    )
    expect(container.textContent).toContain("frontend - React + Vite")
    expect(container.textContent).toContain("backend - Express")
    expect(container.textContent).toContain("PostgreSQL (pg)")
    expect(
      container.querySelector('[data-testid="discovered-target"]')?.textContent,
    ).toBe("frontend")
    expect(loadTarget).toHaveBeenCalledTimes(1)
    expect(loadTarget).toHaveBeenCalledWith(
      analysis.repository,
      { sourceRoot: "frontend" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it("keeps the root native preview blocked while presenting the discovered full-stack target", async () => {
    const analysis = createRootAnalysis()
    const loadTarget = vi
      .fn<BuildTargetAnalysisLoader>()
      .mockResolvedValue(createTargetAnalysis(analysis, "frontend"))
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <RepositoryAnalysisView
          loadBuildTargetAnalysis={loadTarget}
          loadRepositoryAnalysis={vi
            .fn<RepositoryAnalysisLoader>()
            .mockResolvedValue(analysis)}
          loadRepositoryBranches={() =>
            Promise.resolve({
              defaultBranch: "main",
              branches: ["main"],
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
          renderFullStackPreviewControls={(value) => (
            <span data-testid="discovered-target">
              {value.target.sourceRoot}
            </span>
          )}
          repository={{
            owner: analysis.repository.owner,
            repo: analysis.repository.repo,
          }}
        />,
      )
    })

    expect(container.textContent).toContain("Native preview blocked")
    expect(container.textContent).toContain("Full-stack application detected")
    expect(
      container.querySelector('[data-testid="discovered-target"]')?.textContent,
    ).toBe("frontend")
  })

  it("requires an explicit selection when multiple frontend candidates qualify", async () => {
    const analysis = createRootAnalysis({
      frontendRoots: ["frontend", "apps/admin"],
    })
    const loadTarget = vi.fn<BuildTargetAnalysisLoader>(
      async (_repository, target) =>
        createTargetAnalysis(analysis, target.sourceRoot),
    )
    const container = await renderDiscovery(
      analysis,
      loadTarget,
      roots,
      (value) => (
        <span data-testid="discovered-target">{value.target.sourceRoot}</span>
      ),
    )

    expect(container.textContent).toContain(
      "Choose an explicit frontend target to continue",
    )
    expect(
      container.querySelector('[data-testid="discovered-target"]'),
    ).toBeNull()

    const select = container.querySelector<HTMLSelectElement>(
      'select[name="fullstack-frontend-target"]',
    )
    expect(Array.from(select?.options ?? [], (option) => option.value)).toEqual(
      ["", "frontend", "apps/admin"],
    )

    await act(async () => {
      if (!select) throw new Error("frontend selector missing")
      setSelectValue(select, "apps/admin")
    })
    expect(
      container.querySelector('[data-testid="discovered-target"]')?.textContent,
    ).toBe("apps/admin")
  })

  it("locks the frontend selection while create is pending and keeps the original request attached", async () => {
    const analysis = createRootAnalysis({
      frontendRoots: ["frontend", "apps/admin"],
    })
    const pendingCreate = createDeferred<FullStackPreview>()
    let createSignal: AbortSignal | undefined
    const api: FullStackPreviewApi = {
      create: vi.fn((_request, options) => {
        createSignal = options?.signal
        return pendingCreate.promise
      }),
      get: vi.fn(),
      stop: vi.fn(),
    }
    const container = await renderDiscovery(
      analysis,
      vi.fn<BuildTargetAnalysisLoader>(async (_repository, target) =>
        createTargetAnalysis(analysis, target.sourceRoot),
      ),
      roots,
      (value, options) => (
        <FullStackPreviewPanel
          analysis={value}
          fullStackPreviewApi={api}
          getSession={() =>
            Promise.resolve({
              token: "test-session",
              expiresAt: "2099-01-01T00:00:00.000Z",
            })
          }
          onCreatePendingChange={options?.onCreatePendingChange}
        />
      ),
    )
    const select = container.querySelector<HTMLSelectElement>(
      'select[name="fullstack-frontend-target"]',
    )

    await act(async () => {
      if (!select) throw new Error("frontend selector missing")
      setSelectValue(select, "frontend")
    })
    await act(async () => {
      getButton(container, "Run full-stack preview").click()
    })

    expect(select?.disabled).toBe(true)
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ frontendTarget: { sourceRoot: "frontend" } }),
      expect.objectContaining({ signal: createSignal }),
    )
    await act(async () => {
      if (!select) throw new Error("frontend selector missing")
      setSelectValue(select, "apps/admin")
    })
    expect(select?.value).toBe("frontend")
    expect(createSignal?.aborted).toBe(false)

    await act(async () => {
      pendingCreate.resolve(
        createPreview(analysis, {
          frontendSourceRoot: "frontend",
          status: "queued",
        }),
      )
    })

    expect(select?.disabled).toBe(false)
    expect(container.textContent).toContain(
      "fullstack-12345678-1234-1234-1234-123456789abc",
    )
    expect(createSignal?.aborted).toBe(false)
  })

  it("keeps multiple backend candidates explicit and submits the selected source roots", async () => {
    const secondBackend = {
      ...databaseBackend,
      sourceRoot: "services/api",
      environmentRequirements: databaseBackend.environmentRequirements.map(
        (requirement) => ({ ...requirement, sourceRoot: "services/api" }),
      ),
    }
    const analysis = createRootAnalysis({
      backends: [databaseBackend, secondBackend],
    })
    const queued: FullStackPreview = {
      id: "fullstack-12345678-1234-1234-1234-123456789abc",
      repository: {
        repositoryId: analysis.repository.repositoryId,
        owner: analysis.repository.owner,
        name: analysis.repository.repo,
        commitSha: analysis.repository.commitSha,
      },
      frontendSourceRoot: "frontend",
      backendSourceRoot: "services/api",
      status: "queued",
      url: null,
      errorCode: null,
      errorMessage: null,
      createdAt: "2026-10-10T00:00:00.000Z",
      updatedAt: "2026-10-10T00:00:00.000Z",
      expiresAt: "2026-10-10T00:15:00.000Z",
    }
    const api: FullStackPreviewApi = {
      create: vi.fn().mockResolvedValue(queued),
      get: vi.fn().mockResolvedValue(queued),
      stop: vi.fn().mockResolvedValue({ ...queued, status: "stopped" }),
    }
    const container = await renderDiscovery(
      analysis,
      vi
        .fn<BuildTargetAnalysisLoader>()
        .mockResolvedValue(createTargetAnalysis(analysis, "frontend")),
      roots,
      (value) => (
        <FullStackPreviewPanel
          analysis={value}
          fullStackPreviewApi={api}
          getSession={() =>
            Promise.resolve({
              token: "test-session",
              expiresAt: "2099-01-01T00:00:00.000Z",
            })
          }
        />
      ),
    )

    expect(container.textContent).toContain("Choose an explicit backend target")
    expect(findButton(container, "Run full-stack preview")).toBeUndefined()
    const select = container.querySelector<HTMLSelectElement>(
      'select[name="fullstack-backend-target"]',
    )
    await act(async () => {
      if (!select) throw new Error("backend selector missing")
      setSelectValue(select, "services/api")
    })
    await act(async () => {
      getButton(container, "Run full-stack preview").click()
    })

    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({
        contractVersion: "fullstack-v1",
        frontendTarget: { sourceRoot: "frontend" },
        backendSourceRoot: "services/api",
      }),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        idempotencyKey: expect.stringMatching(/^fullstack-request-/),
      }),
    )
  })

  it("filters unsupported frontends and explains unsupported backends", async () => {
    const unsupportedBackend: BackendCandidate = {
      ...databaseBackend,
      framework: "fastify",
      databaseDependencies: [],
      environmentRequirements: [],
    }
    const analysis = createRootAnalysis({ backends: [unsupportedBackend] })
    const loadTarget = vi.fn<BuildTargetAnalysisLoader>().mockResolvedValue(
      createTargetAnalysis(analysis, "frontend", {
        eligible: false,
        blocker: "The frontend build output could not be resolved.",
      }),
    )
    const renderControls = vi.fn<(value: BuildTargetAnalysis) => ReactNode>()
    const container = await renderDiscovery(
      analysis,
      loadTarget,
      roots,
      renderControls,
    )

    expect(container.textContent).toContain(
      "The frontend build output could not be resolved.",
    )
    expect(container.textContent).toContain(
      "fastify execution is not supported yet.",
    )
    expect(container.textContent).toContain(
      "No nested frontend qualifies for native-static-build",
    )
    expect(renderControls).not.toHaveBeenCalled()
  })

  it("does not guess from incomplete structure analysis and offers repository retry", async () => {
    const analysis = createRootAnalysis({ complete: false })
    const loadTarget = vi.fn<BuildTargetAnalysisLoader>()
    const onRetry = vi.fn()
    const container = await renderDiscovery(
      analysis,
      loadTarget,
      roots,
      () => null,
      onRetry,
    )

    expect(container.textContent).toContain(
      "Repository structure analysis is incomplete or truncated",
    )
    expect(loadTarget).not.toHaveBeenCalled()
    await act(async () => {
      getButton(container, "Retry repository analysis").click()
    })
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("retries failed candidate analysis before offering a combination", async () => {
    const analysis = createRootAnalysis()
    const loadTarget = vi
      .fn<BuildTargetAnalysisLoader>()
      .mockRejectedValueOnce(new Error("GitHub target read failed."))
      .mockResolvedValueOnce(createTargetAnalysis(analysis, "frontend"))
    const container = await renderDiscovery(
      analysis,
      loadTarget,
      roots,
      (value) => (
        <span data-testid="discovered-target">{value.target.sourceRoot}</span>
      ),
    )

    expect(container.textContent).toContain("GitHub target read failed.")
    expect(
      container.querySelector('[data-testid="discovered-target"]'),
    ).toBeNull()
    await act(async () => {
      getButton(container, "Retry full-stack discovery").click()
    })
    expect(
      container.querySelector('[data-testid="discovered-target"]')?.textContent,
    ).toBe("frontend")
    expect(loadTarget).toHaveBeenCalledTimes(2)
  })

  it("aborts and ignores stale discovery results after the commit changes", async () => {
    const oldAnalysis = createRootAnalysis({ commitSha: "1".repeat(40) })
    const nextAnalysis = createRootAnalysis({ commitSha: "2".repeat(40) })
    const pending = createDeferred<BuildTargetAnalysis>()
    let oldSignal: AbortSignal | undefined
    const loadTarget = vi.fn<BuildTargetAnalysisLoader>(
      (repository, _target, options) => {
        if (repository.commitSha === oldAnalysis.repository.commitSha) {
          oldSignal = options?.signal
          return pending.promise
        }
        return Promise.resolve(createTargetAnalysis(nextAnalysis, "frontend"))
      },
    )
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    const renderControls = (
      value: BuildTargetAnalysis & RepositoryAnalysis,
    ) => (
      <span data-testid="discovered-commit">{value.repository.commitSha}</span>
    )

    await act(async () => {
      root.render(
        <RootFullStackDiscovery
          analysis={oldAnalysis}
          loadBuildTargetAnalysis={loadTarget}
          onRetryStructure={() => undefined}
          renderControls={renderControls}
        />,
      )
    })
    await act(async () => {
      root.render(
        <RootFullStackDiscovery
          analysis={nextAnalysis}
          loadBuildTargetAnalysis={loadTarget}
          onRetryStructure={() => undefined}
          renderControls={renderControls}
        />,
      )
    })

    expect(oldSignal?.aborted).toBe(true)
    expect(
      container.querySelector('[data-testid="discovered-commit"]')?.textContent,
    ).toBe(nextAnalysis.repository.commitSha)

    await act(async () => {
      pending.resolve(createTargetAnalysis(oldAnalysis, "frontend"))
    })
    expect(
      container.querySelector('[data-testid="discovered-commit"]')?.textContent,
    ).toBe(nextAnalysis.repository.commitSha)
  })
})

function createRootAnalysis(
  options: {
    frontendRoots?: string[]
    backends?: BackendCandidate[]
    complete?: boolean
    truncated?: boolean
    commitSha?: string
  } = {},
): RepositoryAnalysis {
  const frontendRoots = options.frontendRoots ?? ["frontend"]
  const backends = options.backends ?? [databaseBackend]
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
        ...backends.map((candidate) => ({
          path: candidate.sourceRoot,
          isRoot: false,
          role: "project-candidate" as const,
          hasPackageJson: true,
          packageName: candidate.packageName,
          evidence: [],
          warnings: [],
        })),
      ],
      workspaceEvidence: [],
      warnings: [],
      complete: options.complete ?? true,
      truncated: options.truncated ?? false,
    },
    backend: {
      status: backends.length > 0 ? "detected" : "not-detected",
      candidates: backends,
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
  options: { eligible?: boolean; blocker?: string } = {},
): BuildTargetAnalysis {
  const eligible = options.eligible ?? true
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
      mode: eligible ? "native-static-build" : "unsupported",
      blockers: eligible
        ? []
        : [
            {
              code: "UNKNOWN_OUTPUT_DIRECTORY",
              message:
                options.blocker ?? "The frontend target is not supported.",
            },
          ],
    },
    inspectedFiles: supportedAnalysis.inspectedFiles,
    warnings: [],
  }
}

function createPreview(
  analysis: RepositoryAnalysis,
  options: {
    frontendSourceRoot?: string
    status?: FullStackPreview["status"]
  } = {},
): FullStackPreview {
  return {
    id: "fullstack-12345678-1234-1234-1234-123456789abc",
    repository: {
      repositoryId: analysis.repository.repositoryId,
      owner: analysis.repository.owner,
      name: analysis.repository.repo,
      commitSha: analysis.repository.commitSha,
    },
    frontendSourceRoot: options.frontendSourceRoot ?? "frontend",
    backendSourceRoot: "backend",
    status: options.status ?? "queued",
    url: null,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
    expiresAt: "2026-10-10T00:15:00.000Z",
  }
}

async function renderDiscovery(
  analysis: RepositoryAnalysis,
  loadBuildTargetAnalysis: BuildTargetAnalysisLoader,
  roots: Root[],
  renderControls: (
    analysis: BuildTargetAnalysis & RepositoryAnalysis,
    options?: FullStackPreviewRenderOptions,
  ) => ReactNode,
  onRetryStructure = () => undefined,
): Promise<HTMLDivElement> {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <RootFullStackDiscovery
        analysis={analysis}
        loadBuildTargetAnalysis={loadBuildTargetAnalysis}
        onRetryStructure={onRetryStructure}
        renderControls={renderControls}
      />,
    )
  })
  return container
}

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )
  descriptor?.set?.call(select, value)
  select.dispatchEvent(new Event("change", { bubbles: true }))
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
