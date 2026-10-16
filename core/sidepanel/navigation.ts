import {
  createSidePanelMessageHandler,
  createSidePanelPath,
  type SidePanelApi,
  type SidePanelNavigationGuard,
} from "./messages"
import { getRepositoryKey } from "../../utils/githubUrl"
import type { RepositoryIdentity } from "../../types/repository"

/** Uses status only: no tab URL/title, tabs permission or cross-site script. */
export function createSidePanelNavigation(
  sidePanel: SidePanelApi,
  prepareNavigation: (tabId: number) => Promise<void> = async () => undefined,
) {
  // Only a stale-callback guard. Chrome's per-tab options own durable context.
  const versions = new Map<number, number>()
  const boundRepositories = new Map<number, string>()
  const guard: SidePanelNavigationGuard = {
    version: (tabId: number) => versions.get(tabId) ?? 0,
    invalidate: (tabId: number) => {
      versions.set(tabId, (versions.get(tabId) ?? 0) + 1)
    },
    markBound(tabId, repository) {
      boundRepositories.set(tabId, getRepositoryKey(repository))
    },
    canOpen(tabId, repository) {
      return boundRepositories.get(tabId) === getRepositoryKey(repository)
    },
    async prepareOpen(tabId: number, repository: RepositoryIdentity) {
      const version = guard.version(tabId)
      try {
        await prepareNavigation(tabId)
        if (guard.version(tabId) !== version)
          return {
            ok: false,
            error:
              "Navigation changed. Click Peephole on the current repository.",
          }
        await sidePanel.setOptions({
          tabId,
          path: createSidePanelPath(repository, tabId),
          enabled: true,
        })
        if (guard.version(tabId) === version) guard.markBound(tabId, repository)
        // Do not call open after awaits: a new user gesture is required.
        return {
          ok: false,
          error: "Panel context is ready. Click Peephole again to open.",
        }
      } catch {
        return {
          ok: false,
          error:
            "Keep the existing preview controls open until the job can be saved or stopped.",
        }
      }
    },
  }
  return {
    handleMessage: createSidePanelMessageHandler(sidePanel, guard),
    async initialize() {
      await sidePanel.setOptions({ enabled: false })
    },
    async onUpdated(tabId: number, change: { status?: string }) {
      if (change.status !== "loading") return
      guard.invalidate(tabId)
      const version = guard.version(tabId)
      await prepareNavigation(tabId)
      if (guard.version(tabId) !== version) return
      // Omitting path retains the bound repository. Older close({tabId})
      // versions could fall back to closing a global panel, so never call it.
      await sidePanel.setOptions({ tabId, enabled: false })
    },
  }
}
