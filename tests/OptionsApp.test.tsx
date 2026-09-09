// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { OptionsApp } from "../entrypoints/options/App"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = {
  token: "peephole-session",
  expiresAt: "2099-01-01T00:00:00.000Z",
}

describe("OptionsApp", () => {
  const roots: Root[] = []

  afterEach(() => {
    for (const root of roots) act(() => root.unmount())
    roots.length = 0
    document.body.innerHTML = ""
  })

  it("connects and disconnects without exposing a PAT input", async () => {
    const connect = vi.fn().mockResolvedValue(SESSION)
    const disconnect = vi.fn().mockResolvedValue(undefined)
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <OptionsApp
          connect={connect}
          disconnect={disconnect}
          getSession={vi.fn().mockResolvedValue(null)}
          previewApiBaseUrl="https://api.example.test/"
        />,
      )
    })

    expect(container.querySelector("input")).toBeNull()
    expect(container.textContent).toContain("Status: disconnected")

    await act(async () => getButton("Connect GitHub").click())
    expect(connect).toHaveBeenCalledWith("https://api.example.test/")
    expect(container.textContent).toContain("Status: connected")

    await act(async () => getButton("Disconnect").click())
    expect(disconnect).toHaveBeenCalledOnce()
    expect(container.textContent).toContain("Status: disconnected")
  })
})

function getButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  )
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`)
  }
  return button
}
