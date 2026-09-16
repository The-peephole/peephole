import { normalizeGitHubThemeSnapshot } from "../theme/githubTheme"
import type { GitHubThemeSnapshot } from "../../types/theme"
import type {
  SidePanelMessageResponse,
  SidePanelMessageSender,
} from "./messages"
import type { SidePanelThemeStore } from "./themeStorage"

export const SET_GITHUB_THEME = "peephole:github-theme:set"
export const GET_GITHUB_THEME = "peephole:github-theme:get"
export const GITHUB_THEME_UPDATED = "peephole:github-theme:updated"

interface SetGitHubThemeMessage {
  type: typeof SET_GITHUB_THEME
  theme: GitHubThemeSnapshot | null
}

interface GetGitHubThemeMessage {
  type: typeof GET_GITHUB_THEME
  tabId: number
}

export interface GitHubThemeUpdatedMessage {
  type: typeof GITHUB_THEME_UPDATED
  tabId: number
  theme: GitHubThemeSnapshot | null
}

type GitHubThemeMessage = SetGitHubThemeMessage | GetGitHubThemeMessage

interface GetGitHubThemeResponse extends SidePanelMessageResponse {
  theme?: GitHubThemeSnapshot | null
}

export interface GitHubThemeMessageTransport {
  send(message: GitHubThemeMessage): Promise<unknown>
}

export interface GitHubThemeUpdateBroadcaster {
  send(message: GitHubThemeUpdatedMessage): Promise<unknown>
}

export interface GitHubThemeUpdateSubscription {
  addListener(listener: (message: unknown) => void): void
  removeListener(listener: (message: unknown) => void): void
}

export function createGitHubThemeMessageClient(
  transport: GitHubThemeMessageTransport,
): {
  sync(theme: GitHubThemeSnapshot | null): Promise<void>
  load(tabId: number): Promise<GitHubThemeSnapshot | null>
} {
  return {
    async sync(theme) {
      await expectSuccessfulResponse(
        transport.send({ type: SET_GITHUB_THEME, theme }),
      )
    },
    async load(tabId) {
      const response = await transport.send({ type: GET_GITHUB_THEME, tabId })
      if (!isObject(response) || response.ok !== true) {
        throw new Error(getResponseError(response))
      }

      if (response.theme === null) return null
      const theme = normalizeGitHubThemeSnapshot(response.theme)
      if (!theme) {
        throw new Error("The stored GitHub theme is invalid.")
      }
      return theme
    },
  }
}

export function subscribeToGitHubThemeUpdates(
  subscription: GitHubThemeUpdateSubscription,
  tabId: number,
  onThemeChange: (theme: GitHubThemeSnapshot | null) => void,
): () => void {
  const listener = (message: unknown) => {
    const update = parseGitHubThemeUpdatedMessage(message)
    if (update?.tabId === tabId) {
      onThemeChange(update.theme)
    }
  }

  subscription.addListener(listener)
  return () => subscription.removeListener(listener)
}

export function createGitHubThemeMessageHandler(
  store: SidePanelThemeStore,
  broadcaster: GitHubThemeUpdateBroadcaster,
): (
  message: unknown,
  sender: SidePanelMessageSender,
) => Promise<GetGitHubThemeResponse> | undefined {
  return (message, sender) => {
    if (!isObject(message)) return undefined

    if (message.type === SET_GITHUB_THEME) {
      const tabId = getSenderTabId(sender)
      const theme =
        message.theme === null
          ? null
          : normalizeGitHubThemeSnapshot(message.theme)

      if (tabId === null || (message.theme !== null && !theme)) {
        return Promise.resolve({ ok: false, error: "Invalid GitHub theme." })
      }

      return persistAndBroadcastTheme(store, broadcaster, tabId, theme)
    }

    if (message.type === GET_GITHUB_THEME && isTabId(message.tabId)) {
      return loadTheme(store, message.tabId)
    }

    return undefined
  }
}

export function parseGitHubThemeUpdatedMessage(
  value: unknown,
): GitHubThemeUpdatedMessage | null {
  if (
    !isObject(value) ||
    value.type !== GITHUB_THEME_UPDATED ||
    !isTabId(value.tabId)
  ) {
    return null
  }

  if (value.theme === null) {
    return { type: GITHUB_THEME_UPDATED, tabId: value.tabId, theme: null }
  }

  const theme = normalizeGitHubThemeSnapshot(value.theme)
  return theme
    ? { type: GITHUB_THEME_UPDATED, tabId: value.tabId, theme }
    : null
}

async function persistAndBroadcastTheme(
  store: SidePanelThemeStore,
  broadcaster: GitHubThemeUpdateBroadcaster,
  tabId: number,
  theme: GitHubThemeSnapshot | null,
): Promise<GetGitHubThemeResponse> {
  try {
    await store.set(tabId, theme)
    try {
      await broadcaster.send({
        type: GITHUB_THEME_UPDATED,
        tabId,
        theme,
      })
    } catch {
      // The snapshot remains available for a side panel opened later.
    }
    return { ok: true }
  } catch {
    return { ok: false, error: "Chrome could not store the GitHub theme." }
  }
}

async function loadTheme(
  store: SidePanelThemeStore,
  tabId: number,
): Promise<GetGitHubThemeResponse> {
  try {
    return { ok: true, theme: await store.get(tabId) }
  } catch {
    return { ok: false, error: "Chrome could not load the GitHub theme." }
  }
}

async function expectSuccessfulResponse(response: Promise<unknown>) {
  const value = await response
  if (!isObject(value) || value.ok !== true) {
    throw new Error(getResponseError(value))
  }
}

function getResponseError(value: unknown): string {
  return isObject(value) && typeof value.error === "string"
    ? value.error
    : "The Peephole theme service could not be reached."
}

function getSenderTabId(sender: SidePanelMessageSender): number | null {
  const tabId = sender.tab?.id
  return isTabId(tabId) ? tabId : null
}

function isTabId(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
