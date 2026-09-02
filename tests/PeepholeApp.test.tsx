// @vitest-environment jsdom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { PeepholeApp } from "../components/PeepholeApp"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

describe("PeepholeApp", () => {
  const roots: Array<ReturnType<typeof createRoot>> = []

  afterEach(() => {
    for (const root of roots) act(() => root.unmount())
    roots.length = 0
    document.body.innerHTML = ""
  })

  it("opens the Chrome side panel for the current repository", async () => {
    const openSidePanel = vi.fn().mockResolvedValue(undefined)
    const container = createContainer()
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <PeepholeApp
          openSidePanel={openSidePanel}
          repository={{ owner: "react", repo: "react" }}
        />,
      )
    })
    await act(async () => getButton("Peephole").click())

    expect(openSidePanel).toHaveBeenCalledWith({
      owner: "react",
      repo: "react",
    })
    expect(container.textContent).toBe("PPeephole")
  })

  it("shows a safe error when Chrome cannot open the side panel", async () => {
    const openSidePanel = vi
      .fn()
      .mockRejectedValue(new Error("Panel unavailable."))
    const container = createContainer()
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <PeepholeApp
          openSidePanel={openSidePanel}
          repository={{ owner: "react", repo: "react" }}
        />,
      )
    })
    await act(async () => getButton("Peephole").click())

    expect(container.textContent).toContain("Panel unavailable.")
  })
})

function createContainer(): HTMLDivElement {
  const container = document.createElement("div")
  document.body.append(container)
  return container
}

function getButton(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.includes(label),
  )
  if (!button) throw new Error(`Button not found: ${label}`)
  return button
}
