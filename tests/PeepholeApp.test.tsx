// @vitest-environment jsdom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { PeepholeApp } from "../components/PeepholeApp"
import type { RepositoryMetadataLoader } from "../types/repository"

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

  it("loads and displays commit-pinned metadata when opened", async () => {
    const loadRepositoryMetadata = vi
      .fn<RepositoryMetadataLoader>()
      .mockResolvedValue({
        repositoryId: 10270250,
        owner: "facebook",
        repo: "react",
        defaultBranch: "main",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        homepage: "https://react.dev/",
      })
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <PeepholeApp
          loadRepositoryMetadata={loadRepositoryMetadata}
          repository={{ owner: "facebook", repo: "react" }}
        />,
      )
    })

    await act(async () => {
      getButton("Peephole").click()
    })

    expect(container.textContent).toContain("main")
    expect(container.textContent).toContain("0123456")
    expect(container.textContent).toContain("Repository metadata ready")
    expect(container.textContent).not.toContain("StackBlitz")
    expect(loadRepositoryMetadata).toHaveBeenCalledTimes(1)
    expect(
      container.querySelector<HTMLAnchorElement>("a.peephole__link")?.href,
    ).toBe("https://react.dev/")
  })

  it("shows a safe error and retries metadata loading", async () => {
    const loadRepositoryMetadata = vi
      .fn<RepositoryMetadataLoader>()
      .mockRejectedValueOnce(new Error("GitHub could not be reached."))
      .mockResolvedValueOnce({
        repositoryId: 10270250,
        owner: "facebook",
        repo: "react",
        defaultBranch: "main",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        homepage: null,
      })
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <PeepholeApp
          loadRepositoryMetadata={loadRepositoryMetadata}
          repository={{ owner: "facebook", repo: "react" }}
        />,
      )
    })

    await act(async () => {
      getButton("Peephole").click()
    })

    expect(container.textContent).toContain("GitHub could not be reached.")

    await act(async () => {
      getButton("Retry").click()
    })

    expect(container.textContent).toContain("Repository metadata ready")
    expect(loadRepositoryMetadata).toHaveBeenCalledTimes(2)
  })

  it("aborts metadata loading when the panel closes", async () => {
    let requestSignal: AbortSignal | undefined
    const loadRepositoryMetadata = vi.fn<RepositoryMetadataLoader>(
      (_repository, options) => {
        requestSignal = options?.signal
        return new Promise(() => undefined)
      },
    )
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <PeepholeApp
          loadRepositoryMetadata={loadRepositoryMetadata}
          repository={{ owner: "facebook", repo: "react" }}
        />,
      )
    })

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

function getButton(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.includes(label),
  )

  if (!button) {
    throw new Error(`Button not found: ${label}`)
  }

  return button
}
