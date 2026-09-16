import { normalizeGitHubThemeSnapshot } from "../theme/githubTheme"
import type { GitHubThemeSnapshot } from "../../types/theme"

export interface SidePanelThemeStore {
  get(tabId: number): Promise<GitHubThemeSnapshot | null>
  set(tabId: number, theme: GitHubThemeSnapshot | null): Promise<void>
}

interface SessionStorageArea {
  get(key: string): Promise<Record<string, unknown>>
  remove(key: string): Promise<void>
  set(items: Record<string, unknown>): Promise<void>
}

const STORAGE_KEY_PREFIX = "peepholeGitHubTheme:"

export function createSidePanelThemeStore(
  storage: SessionStorageArea = browser.storage.session,
): SidePanelThemeStore {
  return {
    async get(tabId) {
      const key = createThemeStorageKey(tabId)
      const stored = await storage.get(key)
      return normalizeGitHubThemeSnapshot(stored[key])
    },
    async set(tabId, theme) {
      const key = createThemeStorageKey(tabId)
      if (!theme) {
        await storage.remove(key)
        return
      }
      await storage.set({ [key]: theme })
    },
  }
}

export function createThemeStorageKey(tabId: number): string {
  if (!Number.isInteger(tabId) || tabId < 0) {
    throw new Error("A valid tab id is required for GitHub theme storage.")
  }
  return `${STORAGE_KEY_PREFIX}${tabId}`
}
