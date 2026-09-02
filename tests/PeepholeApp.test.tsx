// @vitest-environment jsdom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { PeepholeApp } from "../components/PeepholeApp"
import type { RepositoryAnalysisLoader } from "../types/analysis"
import { supportedAnalysis } from "./analysisFixture"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

describe("PeepholeApp", () => {
  const roots: Array<ReturnType<typeof createRoot>> = []

  afterEach(() => {
    for (const root of roots) {
      act(() => root.unmount())
    }

    roots.length = 0
    document.body.innerHTML = ""
  })

  it("loads and displays repository analysis when opened", async () => {
    const loadRepositoryAnalysis = vi
      .fn<RepositoryAnalysisLoader>()
      .mockResolvedValue(supportedAnalysis)
    const container = createContainer()
    const root = createRoot(container)
    roots.push(root)

    await renderApp(root, loadRepositoryAnalysis)

    await act(async () => {
      getButton("Peephole").click()
    })

    expect(container.textContent).toContain("main")
    expect(container.textContent).toContain("0123456")
    expect(container.textContent).toContain("React + Vite")
    expect(container.textContent).toContain("npm run build")
    expect(container.textContent).toContain("VITE_API_URL")
    expect(container.textContent).toContain("Native preview compatible")
    expect(container.textContent).toContain("Native buildCompatible")
    expect(container.textContent).not.toContain("StackBlitz")
    expect(loadRepositoryAnalysis).toHaveBeenCalledTimes(1)
  })

  it("renders blockers for an unsupported repository", async () => {
    const loadRepositoryAnalysis = vi
      .fn<RepositoryAnalysisLoader>()
      .mockResolvedValue({
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
    const container = createContainer()
    const root = createRoot(container)
    roots.push(root)

    await renderApp(root, loadRepositoryAnalysis)

    await act(async () => {
      getButton("Peephole").click()
    })

    expect(container.textContent).toContain("Native preview blocked")
    expect(container.textContent).toContain("Native buildBlocked")
    expect(container.textContent).toContain(
      "Secret-like environment variables are declared.",
    )
  })

  it("shows a safe error and retries analysis", async () => {
    const loadRepositoryAnalysis = vi
      .fn<RepositoryAnalysisLoader>()
      .mockRejectedValueOnce(new Error("GitHub could not be reached."))
      .mockResolvedValueOnce(supportedAnalysis)
    const container = createContainer()
    const root = createRoot(container)
    roots.push(root)

    await renderApp(root, loadRepositoryAnalysis)

    await act(async () => {
      getButton("Peephole").click()
    })

    expect(container.textContent).toContain("GitHub could not be reached.")

    await act(async () => {
      getButton("Retry").click()
    })

    expect(container.textContent).toContain("Native preview compatible")
    expect(loadRepositoryAnalysis).toHaveBeenCalledTimes(2)
  })

  it("aborts analysis when the panel closes", async () => {
    let requestSignal: AbortSignal | undefined
    const loadRepositoryAnalysis = vi.fn<RepositoryAnalysisLoader>(
      (_repository, options) => {
        requestSignal = options?.signal
        return new Promise(() => undefined)
      },
    )
    const container = createContainer()
    const root = createRoot(container)
    roots.push(root)

    await renderApp(root, loadRepositoryAnalysis)

    await act(async () => {
      getButton("Peephole").click()
    })

    expect(requestSignal?.aborted).toBe(false)

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Close Peephole panel"]',
        )
        ?.click()
    })

    expect(requestSignal?.aborted).toBe(true)
  })
})

function createContainer(): HTMLDivElement {
  const container = document.createElement("div")
  document.body.append(container)
  return container
}

async function renderApp(
  root: ReturnType<typeof createRoot>,
  loadRepositoryAnalysis: RepositoryAnalysisLoader,
): Promise<void> {
  await act(async () => {
    root.render(
      <PeepholeApp
        loadRepositoryAnalysis={loadRepositoryAnalysis}
        repository={{ owner: "react", repo: "react-app" }}
      />,
    )
  })
}

function getButton(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.includes(label),
  )

  if (!button) {
    throw new Error(`Button not found: ${label}`)
  }

  return button
}
