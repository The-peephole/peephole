// @vitest-environment jsdom

import { act, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RepositoryAnalysisView } from "../components/RepositoryAnalysisView"
import { GitHubApiError } from "../core/github/client"
import type {
  RepositoryAnalysis,
  RepositoryAnalysisLoader,
} from "../types/analysis"
import type {
  RepositoryBranchesLoader,
  RepositoryIdentity,
} from "../types/repository"
import { supportedAnalysis } from "./analysisFixture"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

describe("RepositoryAnalysisView", () => {
  const roots: Array<ReturnType<typeof createRoot>> = []

  afterEach(() => {
    for (const root of roots) act(() => root.unmount())
    roots.length = 0
    document.body.innerHTML = ""
  })

  it("loads and displays repository analysis", async () => {
    const loader = vi
      .fn<RepositoryAnalysisLoader>()
      .mockResolvedValue(supportedAnalysis)
    const container = await renderView(loader, roots)

    expect(container.textContent).toContain("main")
    expect(container.textContent).toContain("0123456")
    expect(container.textContent).toContain("React + Vite")
    expect(container.textContent).toContain("npm run build")
    expect(container.textContent).toContain("VITE_API_URL")
    expect(container.textContent).toContain("Native preview compatible")
    expect(container.textContent).not.toContain("StackBlitz")
    expect(loader).toHaveBeenCalledTimes(1)
    expect(loader).toHaveBeenCalledWith(
      {
        repository: { owner: "react", repo: "react" },
        ref: { kind: "default" },
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it("renders blockers for an unsupported repository", async () => {
    const loader = vi.fn<RepositoryAnalysisLoader>().mockResolvedValue({
      ...supportedAnalysis,
      preview: {
        ...supportedAnalysis.preview,
        mode: "unsupported",
        blockers: [
          {
            code: "SECRET_ENV_REQUIRED",
            message: "Secret-like environment variables are declared.",
          },
        ],
      },
    })
    const container = await renderView(loader, roots)

    expect(container.textContent).toContain("Native preview blocked")
    expect(container.textContent).toContain(
      "Secret-like environment variables are declared.",
    )
  })

  it("renders the detected repository structure and project paths", async () => {
    const loader = vi.fn<RepositoryAnalysisLoader>().mockResolvedValue({
      ...supportedAnalysis,
      structure: {
        layout: "workspace",
        projects: [
          {
            path: ".",
            isRoot: true,
            role: "unknown",
            hasPackageJson: true,
            packageName: null,
            evidence: [],
            warnings: [],
          },
          {
            path: "apps/web",
            isRoot: false,
            role: "project-candidate",
            hasPackageJson: true,
            packageName: "@acme/web",
            evidence: ["package.json detected"],
            warnings: [],
          },
          {
            path: "packages/ui",
            isRoot: false,
            role: "package-candidate",
            hasPackageJson: true,
            packageName: null,
            evidence: ["package.json detected"],
            warnings: [],
          },
        ],
        workspaceEvidence: ["package.json workspaces detected"],
        warnings: [],
        complete: true,
        truncated: false,
      },
    })
    const container = await renderView(loader, roots)

    expect(container.textContent).toContain("Structure")
    expect(container.textContent).toContain("Workspace")
    expect(container.textContent).toContain("apps/web")
    expect(container.textContent).toContain("@acme/web")
    expect(container.textContent).toContain("packages/ui")
  })

  it("shows a truncation notice when structure detection hit a bound", async () => {
    const loader = vi.fn<RepositoryAnalysisLoader>().mockResolvedValue({
      ...supportedAnalysis,
      structure: {
        ...supportedAnalysis.structure,
        truncated: true,
      },
    })
    const container = await renderView(loader, roots)

    expect(container.textContent).toContain(
      "Additional projects may exist beyond Peephole's bounded scan.",
    )
  })

  it("shows an incomplete notice when structure detection could not verify everything", async () => {
    const loader = vi.fn<RepositoryAnalysisLoader>().mockResolvedValue({
      ...supportedAnalysis,
      structure: {
        ...supportedAnalysis.structure,
        complete: false,
      },
    })
    const container = await renderView(loader, roots)

    expect(container.textContent).toContain("Structure analysis is incomplete.")
  })

  it("shows a safe error and retries analysis", async () => {
    const loader = vi
      .fn<RepositoryAnalysisLoader>()
      .mockRejectedValueOnce(new Error("GitHub could not be reached."))
      .mockResolvedValueOnce(supportedAnalysis)
    const container = await renderView(loader, roots)

    expect(container.textContent).toContain("GitHub could not be reached.")
    await act(async () => getButton(container, "Retry").click())

    expect(container.textContent).toContain("Native preview compatible")
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it("aborts an in-flight analysis when unmounted", async () => {
    let requestSignal: AbortSignal | undefined
    const loader = vi.fn<RepositoryAnalysisLoader>((_target, options) => {
      requestSignal = options?.signal
      return new Promise(() => undefined)
    })
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <RepositoryAnalysisView
          loadRepositoryAnalysis={loader}
          loadRepositoryBranches={defaultBranchLoader()}
          repository={{ owner: "react", repo: "react" }}
        />,
      )
    })
    expect(requestSignal?.aborted).toBe(false)

    await act(async () => root.unmount())
    roots.splice(roots.indexOf(root), 1)
    expect(requestSignal?.aborted).toBe(true)
  })

  it("lists the default branch and non-default branches, selecting the default branch initially", async () => {
    const loader = vi
      .fn<RepositoryAnalysisLoader>()
      .mockResolvedValue(supportedAnalysis)
    const branchLoader = defaultBranchLoader([
      "main",
      "feature/login",
      "release-1.2.3",
    ])
    const container = await renderView(loader, roots, { branchLoader })

    const select = getBranchSelect(container)
    expect(select.value).toBe("main")
    const optionValues = Array.from(select.options).map(
      (option) => option.value,
    )
    expect(optionValues).toEqual(["main", "feature/login", "release-1.2.3"])
  })

  it("requests analysis with a branch ref target when a non-default branch is selected", async () => {
    const loader = vi
      .fn<RepositoryAnalysisLoader>()
      .mockResolvedValue(supportedAnalysis)
    const branchLoader = defaultBranchLoader(["main", "feature/login"])
    const container = await renderView(loader, roots, { branchLoader })

    await act(async () => selectBranch(container, "feature/login"))

    expect(loader).toHaveBeenLastCalledWith(
      {
        repository: { owner: "react", repo: "react" },
        ref: { kind: "branch", name: "feature/login" },
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it("resolves selecting the default branch by name back to the default ref", async () => {
    const loader = vi
      .fn<RepositoryAnalysisLoader>()
      .mockResolvedValue(supportedAnalysis)
    const branchLoader = defaultBranchLoader(["main", "feature/login"])
    const container = await renderView(loader, roots, { branchLoader })

    await act(async () => selectBranch(container, "feature/login"))
    await act(async () => selectBranch(container, "main"))

    expect(loader).toHaveBeenLastCalledWith(
      {
        repository: { owner: "react", repo: "react" },
        ref: { kind: "default" },
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it("updates the displayed commit SHA after switching branches", async () => {
    const featureAnalysis: RepositoryAnalysis = {
      ...supportedAnalysis,
      repository: {
        ...supportedAnalysis.repository,
        commitSha: "abcdef0123456789abcdef0123456789abcdef01",
      },
    }
    const loader = vi
      .fn<RepositoryAnalysisLoader>()
      .mockImplementation(async (target) =>
        target.ref.kind === "branch" ? featureAnalysis : supportedAnalysis,
      )
    const branchLoader = defaultBranchLoader(["main", "feature/login"])
    const container = await renderView(loader, roots, { branchLoader })

    expect(container.textContent).toContain("0123456")

    await act(async () => selectBranch(container, "feature/login"))

    expect(container.textContent).toContain("abcdef0")
    expect(container.textContent).not.toContain("0123456")
  })

  it("hides preview controls while a newly selected branch resolves, and shows them again once ready", async () => {
    const deferredFeature = createDeferred<RepositoryAnalysis>()
    const loader = vi
      .fn<RepositoryAnalysisLoader>()
      .mockImplementation(async (target) =>
        target.ref.kind === "branch"
          ? deferredFeature.promise
          : supportedAnalysis,
      )
    const branchLoader = defaultBranchLoader(["main", "feature/login"])
    const seenCommitShas: string[] = []
    const container = await renderView(loader, roots, {
      branchLoader,
      renderPreviewControls: (analysis) => {
        seenCommitShas.push(analysis.repository.commitSha)
        return <div data-testid="preview">{analysis.repository.commitSha}</div>
      },
    })

    await act(async () => selectBranch(container, "feature/login"))

    const hiddenWrapper = container.querySelector<HTMLDivElement>(
      ".peephole__analysis",
    )?.parentElement
    expect(hiddenWrapper?.hidden).toBe(true)
    expect(seenCommitShas.at(-1)).toBe(supportedAnalysis.repository.commitSha)

    await act(async () => {
      deferredFeature.resolve({
        ...supportedAnalysis,
        repository: {
          ...supportedAnalysis.repository,
          commitSha: "bbbbbb0123456789abcdef0123456789abcdef01",
        },
      })
    })

    expect(hiddenWrapper?.hidden).toBe(false)
    expect(seenCommitShas.at(-1)).toBe(
      "bbbbbb0123456789abcdef0123456789abcdef01",
    )
  })

  it("ignores stale analysis responses on rapid branch switching (A -> B -> C)", async () => {
    const deferredMain = createDeferred<RepositoryAnalysis>()
    const deferredA = createDeferred<RepositoryAnalysis>()
    const deferredB = createDeferred<RepositoryAnalysis>()
    const signals: AbortSignal[] = []
    const loader = vi.fn<RepositoryAnalysisLoader>((target, options) => {
      signals.push(options!.signal!)
      if (target.ref.kind === "default") return deferredMain.promise
      if (target.ref.name === "feature-a") return deferredA.promise
      return deferredB.promise
    })
    const branchLoader = defaultBranchLoader(["main", "feature-a", "feature-b"])
    const container = await renderView(loader, roots, { branchLoader })

    await act(async () => {
      selectBranch(container, "feature-a")
    })
    await act(async () => {
      selectBranch(container, "feature-b")
    })

    expect(signals).toHaveLength(3)
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(true)
    expect(signals[2]?.aborted).toBe(false)

    await act(async () => {
      deferredB.resolve({
        ...supportedAnalysis,
        repository: {
          ...supportedAnalysis.repository,
          commitSha: "b".repeat(40),
        },
      })
      deferredA.resolve({
        ...supportedAnalysis,
        repository: {
          ...supportedAnalysis.repository,
          commitSha: "a".repeat(40),
        },
      })
      deferredMain.resolve(supportedAnalysis)
    })

    expect(container.textContent).toContain("bbbbbbb")
    expect(container.textContent).not.toContain("aaaaaaa")
  })

  it("does not let branch list failure block or corrupt the default-branch analysis", async () => {
    const loader = vi
      .fn<RepositoryAnalysisLoader>()
      .mockResolvedValue(supportedAnalysis)
    const branchLoader = vi
      .fn<RepositoryBranchesLoader>()
      .mockRejectedValue(new Error("Repository branches could not be loaded."))
    const container = await renderView(loader, roots, { branchLoader })

    expect(container.textContent).toContain(
      "Repository branches could not be loaded.",
    )
    expect(container.textContent).toContain("Native preview compatible")
    expect(loader).toHaveBeenCalledWith(
      {
        repository: { owner: "react", repo: "react" },
        ref: { kind: "default" },
      },
      expect.anything(),
    )
  })

  it("surfaces an explicit error when the selected branch no longer exists, without silently falling back", async () => {
    const loader = vi.fn<RepositoryAnalysisLoader>((target) => {
      if (target.ref.kind === "branch") {
        return Promise.reject(
          new GitHubApiError(
            "not-found",
            'The selected branch "gone" no longer exists or is unavailable.',
          ),
        )
      }
      return Promise.resolve(supportedAnalysis)
    })
    const branchLoader = defaultBranchLoader(["main", "gone"])
    const container = await renderView(loader, roots, { branchLoader })

    await act(async () => selectBranch(container, "gone"))

    expect(container.textContent).toContain(
      'The selected branch "gone" no longer exists',
    )
    expect(
      loader.mock.calls.filter((call) => call[0].ref.kind === "default"),
    ).toHaveLength(1)
  })

  it("resets branch selection to the new repository's default branch on SPA navigation", async () => {
    const repoALoader = vi
      .fn<RepositoryAnalysisLoader>()
      .mockResolvedValue(supportedAnalysis)
    const repoABranches = defaultBranchLoader(["main", "feature-a"])
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <RepositoryAnalysisView
          loadRepositoryAnalysis={repoALoader}
          loadRepositoryBranches={repoABranches}
          repository={{ owner: "acme", repo: "repo-a" }}
        />,
      )
    })
    await act(async () => selectBranch(container, "feature-a"))
    expect(getBranchSelect(container).value).toBe("feature-a")

    const repoBAnalysis: RepositoryAnalysis = {
      ...supportedAnalysis,
      repository: {
        ...supportedAnalysis.repository,
        owner: "acme",
        repo: "repo-b",
        defaultBranch: "trunk",
      },
    }
    const repoBLoader = vi
      .fn<RepositoryAnalysisLoader>()
      .mockResolvedValue(repoBAnalysis)
    const repoBBranches = defaultBranchLoader(["trunk", "dev"], "trunk")

    await act(async () => {
      root.render(
        <RepositoryAnalysisView
          loadRepositoryAnalysis={repoBLoader}
          loadRepositoryBranches={repoBBranches}
          repository={{ owner: "acme", repo: "repo-b" }}
        />,
      )
    })

    expect(getBranchSelect(container).value).toBe("trunk")
    expect(repoBLoader).toHaveBeenCalledWith(
      {
        repository: { owner: "acme", repo: "repo-b" },
        ref: { kind: "default" },
      },
      expect.anything(),
    )
  })
})

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function defaultBranchLoader(
  branches: string[] = ["main"],
  defaultBranch = "main",
): RepositoryBranchesLoader {
  return vi.fn().mockResolvedValue({
    defaultBranch,
    branches,
    truncated: false,
  })
}

async function renderView(
  loader: RepositoryAnalysisLoader,
  roots: Array<ReturnType<typeof createRoot>>,
  options: {
    branchLoader?: RepositoryBranchesLoader
    repository?: RepositoryIdentity
    renderPreviewControls?: (analysis: RepositoryAnalysis) => ReactNode
  } = {},
): Promise<HTMLDivElement> {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)

  await act(async () => {
    root.render(
      <RepositoryAnalysisView
        loadRepositoryAnalysis={loader}
        loadRepositoryBranches={options.branchLoader ?? defaultBranchLoader()}
        renderPreviewControls={options.renderPreviewControls}
        repository={options.repository ?? { owner: "react", repo: "react" }}
      />,
    )
  })
  return container
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.includes(label),
  )
  if (!button) throw new Error(`Button not found: ${label}`)
  return button
}

function getBranchSelect(container: HTMLElement): HTMLSelectElement {
  const select = container.querySelector<HTMLSelectElement>("#peephole-branch")
  if (!select) throw new Error("Branch select not found")
  return select
}

function selectBranch(container: HTMLElement, branchName: string): void {
  const select = getBranchSelect(container)
  const descriptor = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )
  descriptor?.set?.call(select, branchName)
  select.dispatchEvent(new Event("change", { bubbles: true }))
}
