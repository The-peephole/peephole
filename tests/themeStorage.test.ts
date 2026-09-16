import { describe, expect, it, vi } from "vitest"

import {
  createSidePanelThemeStore,
  createThemeStorageKey,
} from "../core/sidepanel/themeStorage"
import { createThemeFixture } from "./themeFixture"

describe("side panel theme session storage", () => {
  it("keeps snapshots isolated by sender tab", async () => {
    const values: Record<string, unknown> = {}
    const storage = {
      get: vi.fn(async (key: string) => ({ [key]: values[key] })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(values, items)
      }),
      remove: vi.fn(async (key: string) => {
        delete values[key]
      }),
    }
    const store = createSidePanelThemeStore(storage)
    const light = createThemeFixture("light")
    const dark = createThemeFixture("dark")

    await store.set(1, light)
    await store.set(2, dark)

    await expect(store.get(1)).resolves.toEqual(light)
    await expect(store.get(2)).resolves.toEqual(dark)
    expect(storage.set).toHaveBeenCalledWith({
      [createThemeStorageKey(1)]: light,
    })
  })

  it("removes a tab snapshot when GitHub theme data becomes unavailable", async () => {
    const storage = {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    }
    const store = createSidePanelThemeStore(storage)

    await store.set(7, null)

    expect(storage.remove).toHaveBeenCalledWith(createThemeStorageKey(7))
  })
})
