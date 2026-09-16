// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { normalizeGitHubThemeSnapshot } from "../core/theme/githubTheme"
import {
  GITHUB_PRIMER_THEME_TOKENS,
  GitHubThemeObserver,
  readGitHubTheme,
} from "../entrypoints/github.content/githubTheme"
import type { GitHubThemeSnapshot } from "../types/theme"
import { createThemeFixture } from "./themeFixture"

describe("GitHub theme detection", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("style")
    document.documentElement.removeAttribute("data-color-mode")
    document.documentElement.removeAttribute("data-light-theme")
    document.documentElement.removeAttribute("data-dark-theme")
  })

  afterEach(() => vi.restoreAllMocks())

  it.each([
    ["GitHub Light", "light", "light", 0x111111],
    ["GitHub Dark", "dark", "dark", 0x222222],
    ["GitHub Dark Dimmed", "dark", "dark_dimmed", 0x333333],
  ] as const)(
    "reads %s from computed semantic tokens",
    (_, scheme, marker, seed) => {
      const expected = createThemeFixture(scheme, seed)
      applyTheme(expected, marker)

      expect(readGitHubTheme(document)).toEqual(expected)
    },
  )

  it("uses a safe fallback when a required semantic token is missing", () => {
    const theme = createThemeFixture("light")
    applyTheme(theme, "light")
    document.documentElement.style.removeProperty("--bgColor-default")

    expect(readGitHubTheme(document)).toBeNull()
  })

  it("rejects malformed theme data instead of passing it to extension CSS", () => {
    const theme = createThemeFixture("dark")
    const malformed = {
      ...theme,
      tokens: { ...theme.tokens, background: "url(javascript:alert(1))" },
    }

    expect(normalizeGitHubThemeSnapshot(malformed)).toBeNull()
    expect(
      normalizeGitHubThemeSnapshot({
        ...theme,
        tokens: { ...theme.tokens, foreground: "#fff; color: red" },
      }),
    ).toBeNull()
    expect(
      normalizeGitHubThemeSnapshot({
        ...theme,
        tokens: { ...theme.tokens, accent: "var(--untrusted)" },
      }),
    ).toBeNull()
  })
})

describe("GitHubThemeObserver", () => {
  it("updates after a focused root theme mutation and deduplicates snapshots", async () => {
    const light = createThemeFixture("light")
    const dimmed = createThemeFixture("dark", 0x303030)
    let currentTheme: GitHubThemeSnapshot | null = light
    let scheduledFrame: FrameRequestCallback | null = null
    const changes: Array<GitHubThemeSnapshot | null> = []
    const observer = new GitHubThemeObserver(
      document,
      (theme) => changes.push(theme),
      () => currentTheme,
      {
        request: vi.fn((callback) => {
          scheduledFrame = callback
          return 1
        }),
        cancel: vi.fn(),
      },
    )

    observer.start()
    expect(changes).toEqual([light])

    currentTheme = dimmed
    document.documentElement.setAttribute("data-dark-theme", "dark_dimmed")
    await flushMutations()
    expect(scheduledFrame).not.toBeNull()
    const runFrame = scheduledFrame as FrameRequestCallback | null
    if (!runFrame) throw new Error("Theme frame was not scheduled.")
    runFrame(0)
    expect(changes).toEqual([light, dimmed])

    scheduledFrame = null
    document.documentElement.setAttribute("data-color-mode", "dark")
    await flushMutations()
    const runDuplicateFrame = scheduledFrame as FrameRequestCallback | null
    if (!runDuplicateFrame) throw new Error("Theme frame was not scheduled.")
    runDuplicateFrame(0)
    expect(changes).toEqual([light, dimmed])

    observer.stop()
  })
})

function applyTheme(theme: GitHubThemeSnapshot, marker: string): void {
  const root = document.documentElement
  root.style.colorScheme = theme.colorScheme
  root.dataset.colorMode = theme.colorScheme
  if (theme.colorScheme === "light") root.dataset.lightTheme = marker
  else root.dataset.darkTheme = marker

  for (const [key, token] of Object.entries(GITHUB_PRIMER_THEME_TOKENS)) {
    root.style.setProperty(
      token,
      theme.tokens[key as keyof GitHubThemeSnapshot["tokens"]],
    )
  }
}

async function flushMutations(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
