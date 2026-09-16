import { describe, expect, it, vi } from "vitest"

import {
  createGitHubThemeMessageClient,
  createGitHubThemeMessageHandler,
  GITHUB_THEME_UPDATED,
  SET_GITHUB_THEME,
  subscribeToGitHubThemeUpdates,
  type GitHubThemeUpdatedMessage,
} from "../core/sidepanel/themeMessages"
import type { SidePanelThemeStore } from "../core/sidepanel/themeStorage"
import type { GitHubThemeSnapshot } from "../types/theme"
import { createThemeFixture } from "./themeFixture"

describe("GitHub theme messages", () => {
  it("stores and broadcasts a validated snapshot for the sender tab", async () => {
    const theme = createThemeFixture("dark", 0x303030)
    const store = createThemeStore()
    const send = vi.fn().mockResolvedValue(undefined)
    const handler = createGitHubThemeMessageHandler(store, { send })

    const response = await handler(
      { type: SET_GITHUB_THEME, theme },
      { tab: { id: 17 } },
    )

    expect(response).toEqual({ ok: true })
    await expect(store.get(17)).resolves.toEqual(theme)
    expect(send).toHaveBeenCalledWith({
      type: GITHUB_THEME_UPDATED,
      tabId: 17,
      theme,
    })
  })

  it("rejects malformed snapshots before storage or broadcast", async () => {
    const store = createThemeStore()
    const set = vi.spyOn(store, "set")
    const send = vi.fn().mockResolvedValue(undefined)
    const handler = createGitHubThemeMessageHandler(store, { send })

    const response = await handler(
      {
        type: SET_GITHUB_THEME,
        theme: {
          colorScheme: "dark",
          tokens: { background: "url(https://example.com)" },
        },
      },
      { tab: { id: 17 } },
    )

    expect(response).toEqual({ ok: false, error: "Invalid GitHub theme." })
    expect(set).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it("loads the snapshot for the requested tab", async () => {
    const theme = createThemeFixture("light")
    const store = createThemeStore([[42, theme]])
    const handler = createGitHubThemeMessageHandler(store, {
      send: vi.fn().mockResolvedValue(undefined),
    })
    const client = createGitHubThemeMessageClient({
      send: async (message) => handler(message, {}) ?? { ok: false },
    })

    await expect(client.load(42)).resolves.toEqual(theme)
  })

  it("delivers only valid updates for the current side-panel tab", () => {
    const listeners = new Set<(message: unknown) => void>()
    const theme = createThemeFixture("dark")
    const onThemeChange = vi.fn()
    const unsubscribe = subscribeToGitHubThemeUpdates(
      {
        addListener: (listener) => listeners.add(listener),
        removeListener: (listener) => listeners.delete(listener),
      },
      9,
      onThemeChange,
    )

    broadcast(listeners, { type: GITHUB_THEME_UPDATED, tabId: 8, theme })
    broadcast(listeners, { type: GITHUB_THEME_UPDATED, tabId: 9, theme })
    broadcast(listeners, {
      type: GITHUB_THEME_UPDATED,
      tabId: 9,
      theme: { colorScheme: "dark", tokens: {} } as GitHubThemeSnapshot,
    })

    expect(onThemeChange).toHaveBeenCalledTimes(1)
    expect(onThemeChange).toHaveBeenCalledWith(theme)
    unsubscribe()
    expect(listeners.size).toBe(0)
  })
})

function createThemeStore(
  initial: Array<[number, GitHubThemeSnapshot | null]> = [],
): SidePanelThemeStore {
  const themes = new Map(initial)
  return {
    get: async (tabId) => themes.get(tabId) ?? null,
    set: async (tabId, theme) => {
      if (theme) themes.set(tabId, theme)
      else themes.delete(tabId)
    },
  }
}

function broadcast(
  listeners: Set<(message: unknown) => void>,
  message: GitHubThemeUpdatedMessage,
): void {
  for (const listener of listeners) listener(message)
}
