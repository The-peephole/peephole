// @vitest-environment jsdom

import { act, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RepositoryAnalysisView } from "../components/RepositoryAnalysisView"
import { GitHubApiError } from "../core/github/client"
import type {
  BuildTargetAnalysis,
  BuildTargetAnalysisLoader,
  RepositoryAnalysis,
  RepositoryAnalysisLoader,
} from "../types/analysis"
import type { BackendCandidate } from "../types/backend"
import type {
  RepositoryLiveDeployment,
  RepositoryLiveDeploymentLoader,
} from "../types/deployment"
import type {
  RepositoryBranchesLoader,
  RepositoryIdentity,
  RepositoryMetadata,
} from "../types/repository"
import { supportedAnalysis } from "./analysisFixture"

const notDetectedDeployment: RepositoryLiveDeployment = {
  status: "not-detected",
  candidate: null,
  candidateCount: 0,
  truncated: false,
  evidence: [],
}

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

  it("offers only application candidates and analyzes the selected exact-SHA target", async () => {
    const analysis: RepositoryAnalysis = {
      ...supportedAnalysis,
      structure: {
        layout: "workspace",
        projects: [
          {
            path: ".",
            isRoot: true,
            role: "package-candidate",
            hasPackageJson: true,
            packageName: "root",
            evidence: [],
            warnings: [],
          },
          {
            path: "apps/web",
            isRoot: false,
            role: "project-candidate",
            hasPackageJson: true,
            packageName: "web",
            evidence: [],
            warnings: [],
          },
          {
            path: "apps/api",
            isRoot: false,
            role: "unknown",
            hasPackageJson: true,
            packageName: "api",
            evidence: [],
            warnings: [],
          },
        ],
        workspaceEvidence: [],
        warnings: [],
        complete: true,
        truncated: false,
      },
    }
    const loadTarget = vi.fn<BuildTargetAnalysisLoader>().mockResolvedValue({
      repository: analysis.repository,
      targetAnalyzerVersion: "test",
      target: { sourceRoot: "apps/web" },
      technologies: analysis.technologies,
      packageManager: analysis.packageManager,
      runtime: analysis.runtime,
      environment: analysis.environment,
      environmentRequirements: analysis.environmentRequirements,
      preview: { ...analysis.preview, contractVersion: "static-v2" },
      inspectedFiles: analysis.inspectedFiles,
      warnings: analysis.warnings,
    })
    const container = await renderView(
      vi.fn<RepositoryAnalysisLoader>().mockResolvedValue(analysis),
      roots,
      {
        loadBuildTargetAnalysis: loadTarget,
        renderPreviewControls: (value) => (
          <span data-testid="selected-target">{value.target.sourceRoot}</span>
        ),
      },
    )
    const select = container.querySelector<HTMLSelectElement>(
      'select[name="preview-target"]',
    )
    expect(select).not.toBeNull()
    expect(
      Array.from(select?.options ?? []).map((option) => option.value),
    ).toEqual([".", "apps/web"])

    await act(async () => {
      if (!select) throw new Error("target selector missing")
      select.value = "apps/web"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })

    expect(loadTarget).toHaveBeenCalledWith(
      analysis.repository,
      { sourceRoot: "apps/web" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(
      container.querySelector('[data-testid="selected-target"]')?.textContent,
    ).toBe("apps/web")
  })

  it("aborts and ignores stale target analysis on a rapid nested-to-root switch", async () => {
    const analysis = createTargetableAnalysis()
    const pending = createDeferred<BuildTargetAnalysis>()
    let signal: AbortSignal | undefined
    const loadTarget = vi.fn<BuildTargetAnalysisLoader>(
      (_repository, _target, options) => {
        signal = options?.signal
        return pending.promise
      },
    )
    const container = await renderView(
      vi.fn<RepositoryAnalysisLoader>().mockResolvedValue(analysis),
      roots,
      {
        loadBuildTargetAnalysis: loadTarget,
        renderPreviewControls: (value) => (
          <span data-testid="race-target">{value.target.sourceRoot}</span>
        ),
      },
    )
    const select = container.querySelector<HTMLSelectElement>(
      'select[name="preview-target"]',
    )
    if (!select) throw new Error("target selector missing")

    await act(async () => {
      select.value = "apps/web"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await act(async () => {
      select.value = "."
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(signal?.aborted).toBe(true)

    await act(async () => {
      pending.resolve({
        repository: analysis.repository,
        targetAnalyzerVersion: "stale",
        target: { sourceRoot: "apps/web" },
        technologies: analysis.technologies,
        packageManager: analysis.packageManager,
        runtime: analysis.runtime,
        environment: analysis.environment,
        environmentRequirements: analysis.environmentRequirements,
        preview: analysis.preview,
        inspectedFiles: analysis.inspectedFiles,
        warnings: analysis.warnings,
      })
    })
    expect(
      container.querySelector('[data-testid="race-target"]')?.textContent,
    ).toBe(".")
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

  it("renders the repository homepage separately from live deployment status", async () => {
    const loader = vi.fn<RepositoryAnalysisLoader>().mockResolvedValue({
      ...supportedAnalysis,
      repository: {
        ...supportedAnalysis.repository,
        homepage: "https://chromewebstore.google.com/detail/example",
      },
    })
    const container = await renderView(loader, roots, {
      loadRepositoryLiveDeployment: () =>
        Promise.resolve(notDetectedDeployment),
    })

    expect(container.textContent).toContain("Repository homepage")
    expect(container.textContent).toContain("Open homepage")
    expect(container.textContent).toContain("Live deployment")
    expect(container.textContent).toContain("Not detected")
  })

  it("renders the repository homepage separately even when Vercel configuration evidence also exists", async () => {
    const loader = vi.fn<RepositoryAnalysisLoader>().mockResolvedValue({
      ...supportedAnalysis,
      repository: {
        ...supportedAnalysis.repository,
        homepage: "https://example.com/",
      },
      deployment: {
        status: "configured",
        provider: "vercel",
        url: null,
        evidence: ["Vercel configuration detected"],
      },
    })
    const container = await renderView(loader, roots, {
      loadRepositoryLiveDeployment: () =>
        Promise.resolve(notDetectedDeployment),
    })

    expect(container.textContent).toContain("Repository homepage")
    expect(container.textContent).toContain("Open homepage")
    expect(container.textContent).toContain("Deployment configuration")
    expect(container.textContent).toContain("Vercel configuration detected")
  })

  it("never labels a homepage-only repository as a confirmed live deployment", async () => {
    const loader = vi.fn<RepositoryAnalysisLoader>().mockResolvedValue({
      ...supportedAnalysis,
      repository: {
        ...supportedAnalysis.repository,
        homepage: "https://chromewebstore.google.com/detail/example",
      },
    })
    const container = await renderView(loader, roots, {
      loadRepositoryLiveDeployment: () =>
        Promise.resolve(notDetectedDeployment),
    })

    expect(container.textContent).not.toContain("Open live site")
    expect(container.querySelector("iframe")).toBeNull()
  })

  it("renders a confirmed live deployment with its comparison to the selected commit", async () => {
    const loader = vi
      .fn<RepositoryAnalysisLoader>()
      .mockResolvedValue(supportedAnalysis)
    const container = await renderView(loader, roots, {
      loadRepositoryLiveDeployment: () =>
        Promise.resolve({
          status: "confirmed",
          candidate: {
            environment: "production",
            productionEnvironment: true,
            url: "https://myapp.vercel.app",
            ref: "main",
            sha: supportedAnalysis.repository.commitSha,
            state: "success",
          },
          candidateCount: 1,
          truncated: false,
          evidence: [],
        }),
    })

    expect(container.textContent).toContain("Confirmed")
    expect(container.textContent).toContain("https://myapp.vercel.app")
    expect(container.textContent).toContain("Matches selected commit")
    const link = Array.from(container.querySelectorAll("a")).find(
      (anchor) => anchor.textContent === "Open live site",
    )
    expect(link?.getAttribute("href")).toBe("https://myapp.vercel.app")
    expect(link?.getAttribute("target")).toBe("_blank")
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer")
    expect(container.querySelector("iframe")).toBeNull()
  })

  it("shows a commit mismatch when the deployment SHA differs from the selected commit", async () => {
    const loader = vi
      .fn<RepositoryAnalysisLoader>()
      .mockResolvedValue(supportedAnalysis)
    const container = await renderView(loader, roots, {
      loadRepositoryLiveDeployment: () =>
        Promise.resolve({
          status: "confirmed",
          candidate: {
            environment: "production",
            productionEnvironment: true,
            url: "https://myapp.vercel.app",
            ref: "main",
            sha: "f".repeat(40),
            state: "success",
          },
          candidateCount: 1,
          truncated: false,
          evidence: [],
        }),
    })

    expect(container.textContent).toContain(
      "Deployment commit differs from selected preview commit",
    )
  })

  it("isolates a deployment lookup failure without affecting Build Preview or analysis", async () => {
    const loader = vi
      .fn<RepositoryAnalysisLoader>()
      .mockResolvedValue(supportedAnalysis)
    const container = await renderView(loader, roots, {
      loadRepositoryLiveDeployment: () =>
        Promise.reject(
          new Error("Deployment information is currently unavailable."),
        ),
    })

    expect(container.textContent).toContain(
      "Deployment information is currently unavailable.",
    )
    expect(container.textContent).toContain("Native preview compatible")
  })

  it("does not refetch the live deployment when the selected branch changes", async () => {
    const loader = vi
      .fn<RepositoryAnalysisLoader>()
      .mockResolvedValue(supportedAnalysis)
    const branchLoader = defaultBranchLoader(["main", "feature/login"])
    const loadDeployment = vi
      .fn<RepositoryLiveDeploymentLoader>()
      .mockResolvedValue(notDetectedDeployment)
    const container = await renderView(loader, roots, {
      branchLoader,
      loadRepositoryLiveDeployment: loadDeployment,
    })

    await act(async () => selectBranch(container, "feature/login"))

    expect(loadDeployment).toHaveBeenCalledTimes(1)
  })

  it("clears previous deployment information on repository SPA navigation", async () => {
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    const deferredDeploymentA = createDeferred<RepositoryLiveDeployment>()

    await act(async () => {
      root.render(
        <RepositoryAnalysisView
          loadRepositoryAnalysis={vi
            .fn<RepositoryAnalysisLoader>()
            .mockResolvedValue(supportedAnalysis)}
          loadRepositoryBranches={defaultBranchLoader()}
          loadRepositoryLiveDeployment={() => deferredDeploymentA.promise}
          repository={{ owner: "acme", repo: "repo-a" }}
        />,
      )
    })

    await act(async () => {
      root.render(
        <RepositoryAnalysisView
          loadRepositoryAnalysis={vi
            .fn<RepositoryAnalysisLoader>()
            .mockResolvedValue(supportedAnalysis)}
          loadRepositoryBranches={defaultBranchLoader()}
          loadRepositoryLiveDeployment={() =>
            Promise.resolve({
              status: "confirmed",
              candidate: {
                environment: "production",
                productionEnvironment: true,
                url: "https://repo-b.example.com",
                ref: "main",
                sha: null,
                state: "success",
              },
              candidateCount: 1,
              truncated: false,
              evidence: [],
            })
          }
          repository={{ owner: "acme", repo: "repo-b" }}
        />,
      )
    })

    await act(async () => {
      deferredDeploymentA.resolve({
        status: "confirmed",
        candidate: {
          environment: "production",
          productionEnvironment: true,
          url: "https://repo-a.example.com",
          ref: "main",
          sha: null,
          state: "success",
        },
        candidateCount: 1,
        truncated: false,
        evidence: [],
      })
    })

    expect(container.textContent).toContain("https://repo-b.example.com")
    expect(container.textContent).not.toContain("https://repo-a.example.com")
  })

  it('shows "No backend detected" when no backend evidence exists', async () => {
    const loader = vi
      .fn<RepositoryAnalysisLoader>()
      .mockResolvedValue(supportedAnalysis)
    const container = await renderView(loader, roots)

    expect(container.textContent).toContain("Backend")
    expect(container.textContent).toContain("No backend detected.")
  })

  it("renders a detected backend candidate as detected-but-not-executable", async () => {
    const loader = vi.fn<RepositoryAnalysisLoader>().mockResolvedValue({
      ...supportedAnalysis,
      backend: {
        status: "detected",
        candidates: [
          {
            sourceRoot: "backend",
            framework: "express",
            runtime: "node",
            packageName: "backend",
            entrypoint: "src/server.js",
            databaseDependencies: [],
            environmentRequirements: [],
            // No package-lock.json: does not qualify for backend-v1
            // execution support, so this stays "Not supported yet" -- see
            // the dedicated "shows execution support" test below for the
            // qualifying-candidate case.
            packageLockPresent: false,
            evidence: ["express dependency detected"],
            warnings: [],
          },
        ],
        evidence: ["1 backend candidate detected"],
        warnings: [],
        complete: true,
        truncated: false,
      },
    })
    const container = await renderView(loader, roots)

    expect(container.textContent).toContain("Express")
    expect(container.textContent).toContain("backend")
    expect(container.textContent).toContain("Not supported yet")
    expect(container.textContent).not.toContain("No backend detected.")
  })

  it("shows execution support and renders backend runtime controls only for a qualifying candidate", async () => {
    const loader = vi.fn<RepositoryAnalysisLoader>().mockResolvedValue({
      ...supportedAnalysis,
      backend: {
        status: "detected",
        candidates: [
          {
            sourceRoot: "backend",
            framework: "express",
            runtime: "node",
            packageName: "backend",
            entrypoint: "src/server.js",
            databaseDependencies: [],
            environmentRequirements: [],
            packageLockPresent: true,
            evidence: ["express dependency detected"],
            warnings: [],
          },
        ],
        evidence: ["1 backend candidate detected"],
        warnings: [],
        complete: true,
        truncated: false,
      },
    })
    const renderBackendRuntimeControls = vi.fn(() => (
      <button type="button">Start backend</button>
    ))
    const container = await renderView(loader, roots, {
      renderBackendRuntimeControls,
    })

    expect(container.textContent).toContain("Supported (express-node-npm-v1)")
    expect(container.textContent).not.toContain("Not supported yet")
    expect(container.textContent).toContain("Start backend")
    expect(renderBackendRuntimeControls).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: expect.objectContaining({ sourceRoot: "backend" }),
      }),
    )
    // Still never a preview-target option and never a backend URL/link.
    const select = container.querySelector<HTMLSelectElement>(
      'select[name="preview-target"]',
    )
    const options = Array.from(select?.options ?? []).map(
      (option) => option.value,
    )
    expect(options).not.toContain("backend")
  })

  it("shows compatibility without a Start control when runtime capability is disabled", async () => {
    const loader = vi.fn<RepositoryAnalysisLoader>().mockResolvedValue({
      ...supportedAnalysis,
      backend: {
        status: "detected",
        candidates: [
          {
            sourceRoot: "backend",
            framework: "express",
            runtime: "node",
            packageName: "backend",
            entrypoint: "src/server.js",
            databaseDependencies: [],
            environmentRequirements: [],
            packageLockPresent: true,
            evidence: ["express dependency detected"],
            warnings: [],
          },
        ],
        evidence: ["1 backend candidate detected"],
        warnings: [],
        complete: true,
        truncated: false,
      },
    })
    const container = await renderView(loader, roots)

    expect(container.textContent).toContain(
      "Compatible (backend-v1) - disabled",
    )
    expect(container.textContent).not.toContain(
      "Supported (express-node-npm-v1)",
    )
    expect(container.textContent).not.toContain("Start backend")
  })

  it("does not advertise an explicit pnpm backend as runtime-compatible", async () => {
    const loader = vi.fn<RepositoryAnalysisLoader>().mockResolvedValue({
      ...supportedAnalysis,
      backend: {
        status: "detected",
        candidates: [
          {
            sourceRoot: "backend",
            framework: "express",
            runtime: "node",
            packageName: "backend",
            packageManager: "pnpm@9.0.0",
            entrypoint: "src/server.js",
            databaseDependencies: [],
            environmentRequirements: [],
            packageLockPresent: true,
            evidence: ["express dependency detected"],
            warnings: [],
          },
        ],
        evidence: ["1 backend candidate detected"],
        warnings: [],
        complete: true,
        truncated: false,
      },
    })
    const renderBackendRuntimeControls = vi.fn(() => (
      <button type="button">Start backend</button>
    ))
    const container = await renderView(loader, roots, {
      renderBackendRuntimeControls,
    })

    expect(container.textContent).toContain("Not supported yet")
    expect(container.textContent).not.toContain("Compatible (backend-v1)")
    expect(container.textContent).not.toContain("Start backend")
    expect(renderBackendRuntimeControls).not.toHaveBeenCalled()
  })

  it("never offers a backend candidate as a selectable or runnable preview target", async () => {
    const loader = vi.fn<RepositoryAnalysisLoader>().mockResolvedValue({
      ...supportedAnalysis,
      backend: {
        status: "detected",
        candidates: [
          {
            sourceRoot: "backend",
            framework: "express",
            runtime: "node",
            packageName: null,
            entrypoint: null,
            databaseDependencies: [],
            environmentRequirements: [],
            packageLockPresent: true,
            evidence: [],
            warnings: [],
          },
        ],
        evidence: [],
        warnings: [],
        complete: true,
        truncated: false,
      },
    })
    const container = await renderView(loader, roots)

    const select = container.querySelector<HTMLSelectElement>(
      'select[name="preview-target"]',
    )
    const options = Array.from(select?.options ?? []).map(
      (option) => option.value,
    )
    expect(options).not.toContain("backend")
    expect(container.textContent).not.toContain("Run backend")
    expect(container.textContent).not.toContain("Start server")
  })

  it("classifies environment requirements grouped by source root without ever showing a raw value", async () => {
    const loader = vi.fn<RepositoryAnalysisLoader>().mockResolvedValue({
      ...supportedAnalysis,
      environmentRequirements: [
        {
          name: "VITE_API_URL",
          sourceRoot: ".",
          sourceTemplate: ".env.example",
          exposure: "client-public",
          requirementKind: "external-routing-candidate",
          sensitivity: "public",
          evidence: [],
          warnings: [],
        },
      ],
      backend: {
        status: "detected",
        candidates: [
          {
            sourceRoot: "backend",
            framework: "express",
            runtime: "node",
            packageName: null,
            entrypoint: null,
            databaseDependencies: [],
            packageLockPresent: true,
            environmentRequirements: [
              {
                name: "PORT",
                sourceRoot: "backend",
                sourceTemplate: ".env.example",
                exposure: "server",
                requirementKind: "auto-configurable",
                sensitivity: "public",
                evidence: [],
                warnings: [],
              },
              {
                name: "JWT_SECRET",
                sourceRoot: "backend",
                sourceTemplate: ".env.example",
                exposure: "server",
                requirementKind: "preview-generated-candidate",
                sensitivity: "secret-like",
                evidence: [],
                warnings: [],
              },
            ],
            evidence: [],
            warnings: [],
          },
        ],
        evidence: [],
        warnings: [],
        complete: true,
        truncated: false,
      },
    })
    const container = await renderView(loader, roots)

    expect(container.textContent).toContain("PORT")
    expect(container.textContent).toContain("Auto-configurable candidate")
    expect(container.textContent).toContain("JWT_SECRET")
    expect(container.textContent).toContain(
      "Preview-generated secret candidate",
    )
    expect(container.textContent).toContain("VITE_API_URL")
    expect(container.textContent).toContain("External/routing requirement")
    expect(container.textContent).toContain("backend")
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

function createTargetableAnalysis(): RepositoryAnalysis {
  return {
    ...supportedAnalysis,
    structure: {
      layout: "workspace",
      projects: [
        {
          path: ".",
          isRoot: true,
          role: "package-candidate",
          hasPackageJson: true,
          packageName: "root",
          evidence: [],
          warnings: [],
        },
        {
          path: "apps/web",
          isRoot: false,
          role: "project-candidate",
          hasPackageJson: true,
          packageName: "web",
          evidence: [],
          warnings: [],
        },
      ],
      workspaceEvidence: [],
      warnings: [],
      complete: true,
      truncated: false,
    },
  }
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
    loadBuildTargetAnalysis?: BuildTargetAnalysisLoader
    loadRepositoryLiveDeployment?: RepositoryLiveDeploymentLoader
    repository?: RepositoryIdentity
    renderPreviewControls?: (
      analysis: BuildTargetAnalysis & RepositoryAnalysis,
    ) => ReactNode
    renderBackendRuntimeControls?: (input: {
      candidate: BackendCandidate
      repository: RepositoryMetadata
    }) => ReactNode
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
        loadBuildTargetAnalysis={options.loadBuildTargetAnalysis}
        loadRepositoryBranches={options.branchLoader ?? defaultBranchLoader()}
        loadRepositoryLiveDeployment={
          options.loadRepositoryLiveDeployment ??
          (() => Promise.resolve(notDetectedDeployment))
        }
        renderPreviewControls={options.renderPreviewControls}
        renderBackendRuntimeControls={options.renderBackendRuntimeControls}
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
