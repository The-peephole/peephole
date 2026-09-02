// @vitest-environment jsdom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RepositoryAnalysisView } from "../components/RepositoryAnalysisView"
import type { RepositoryAnalysisLoader } from "../types/analysis"
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

  it("shows a safe error and retries analysis", async () => {
    const loader = vi
      .fn<RepositoryAnalysisLoader>()
      .mockRejectedValueOnce(new Error("GitHub could not be reached."))
      .mockResolvedValueOnce(supportedAnalysis)
    const container = await renderView(loader, roots)

    expect(container.textContent).toContain("GitHub could not be reached.")
    await act(async () => getButton("Retry").click())

    expect(container.textContent).toContain("Native preview compatible")
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it("aborts an in-flight analysis when unmounted", async () => {
    let requestSignal: AbortSignal | undefined
    const loader = vi.fn<RepositoryAnalysisLoader>((_repository, options) => {
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
          repository={{ owner: "react", repo: "react" }}
        />,
      )
    })
    expect(requestSignal?.aborted).toBe(false)

    await act(async () => root.unmount())
    roots.splice(roots.indexOf(root), 1)
    expect(requestSignal?.aborted).toBe(true)
  })
})

async function renderView(
  loader: RepositoryAnalysisLoader,
  roots: Array<ReturnType<typeof createRoot>>,
): Promise<HTMLDivElement> {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)

  await act(async () => {
    root.render(
      <RepositoryAnalysisView
        loadRepositoryAnalysis={loader}
        repository={{ owner: "react", repo: "react" }}
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
