// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"

import { PEEPHOLE_THEME_CSS_VARIABLES } from "../core/theme/githubTheme"
import { SidePanelThemeController } from "../entrypoints/sidepanel/SidePanelThemeController"
import type { GitHubThemeSnapshot } from "../types/theme"
import { createThemeFixture } from "./themeFixture"

describe("SidePanelThemeController", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("style")
    document.documentElement.removeAttribute("data-peephole-theme")
    document.body.innerHTML = ""
  })

  it("updates CSS tokens without replacing analysis or preview DOM state", async () => {
    const light = createThemeFixture("light")
    const dimmed = createThemeFixture("dark", 0x303030)
    let listener: ((theme: GitHubThemeSnapshot | null) => void) | null = null
    const preview = document.createElement("iframe")
    preview.src = "https://preview.example.test/"
    const state = document.createElement("input")
    state.value = "analysis-state"
    document.body.append(state, preview)

    const controller = new SidePanelThemeController(
      document.documentElement,
      17,
      {
        load: vi.fn().mockResolvedValue(light),
        subscribe: (_tabId, onThemeChange) => {
          listener = onThemeChange
          return vi.fn()
        },
      },
    )

    controller.start()
    await flushPromises()
    expect(document.documentElement.dataset.peepholeTheme).toBe("light")
    expect(
      document.documentElement.style.getPropertyValue(
        PEEPHOLE_THEME_CSS_VARIABLES.background,
      ),
    ).toBe(light.tokens.background)

    const sendTheme = listener as
      ((theme: GitHubThemeSnapshot | null) => void) | null
    if (!sendTheme) throw new Error("Theme update listener was not installed.")
    sendTheme(dimmed)

    expect(document.documentElement.dataset.peepholeTheme).toBe("dark")
    expect(document.body.querySelector("iframe")).toBe(preview)
    expect(preview.src).toBe("https://preview.example.test/")
    expect(state.value).toBe("analysis-state")
    controller.stop()
  })

  it("does not let a stale initial load overwrite a runtime theme update", async () => {
    const light = createThemeFixture("light")
    const dark = createThemeFixture("dark")
    let resolveLoad: ((theme: GitHubThemeSnapshot | null) => void) | null = null
    let listener: ((theme: GitHubThemeSnapshot | null) => void) | null = null
    const controller = new SidePanelThemeController(
      document.documentElement,
      4,
      {
        load: () =>
          new Promise((resolve) => {
            resolveLoad = resolve
          }),
        subscribe: (_tabId, onThemeChange) => {
          listener = onThemeChange
          return vi.fn()
        },
      },
    )

    controller.start()
    const sendTheme = listener as
      ((theme: GitHubThemeSnapshot | null) => void) | null
    if (!sendTheme) throw new Error("Theme update listener was not installed.")
    sendTheme(dark)
    const finishLoad = resolveLoad as
      ((theme: GitHubThemeSnapshot | null) => void) | null
    if (!finishLoad) throw new Error("Theme load was not started.")
    finishLoad(light)
    await flushPromises()

    expect(document.documentElement.dataset.peepholeTheme).toBe("dark")
    expect(
      document.documentElement.style.getPropertyValue(
        PEEPHOLE_THEME_CSS_VARIABLES.background,
      ),
    ).toBe(dark.tokens.background)
    controller.stop()
  })

  it("clears invalid data so the safe CSS fallback remains active", async () => {
    let listener: ((theme: GitHubThemeSnapshot | null) => void) | null = null
    const controller = new SidePanelThemeController(
      document.documentElement,
      2,
      {
        load: vi.fn().mockResolvedValue(createThemeFixture("light")),
        subscribe: (_tabId, onThemeChange) => {
          listener = onThemeChange
          return vi.fn()
        },
      },
    )

    controller.start()
    await flushPromises()
    const sendTheme = listener as
      ((theme: GitHubThemeSnapshot | null) => void) | null
    if (!sendTheme) throw new Error("Theme update listener was not installed.")
    sendTheme({
      colorScheme: "dark",
      tokens: {
        ...createThemeFixture("dark").tokens,
        background: "url(https://example.test)",
      },
    })

    expect(document.documentElement.dataset.peepholeTheme).toBeUndefined()
    expect(
      document.documentElement.style.getPropertyValue(
        PEEPHOLE_THEME_CSS_VARIABLES.background,
      ),
    ).toBe("")
    controller.stop()
  })
})

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
