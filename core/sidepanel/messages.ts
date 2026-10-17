import type { RepositoryIdentity } from "../../types/repository"

export const SET_SIDE_PANEL_CONTEXT = "peephole:side-panel:set-context"
export const OPEN_SIDE_PANEL = "peephole:side-panel:open"

interface SetSidePanelContextMessage {
  type: typeof SET_SIDE_PANEL_CONTEXT
  repository: RepositoryIdentity | null
}

interface OpenSidePanelMessage {
  type: typeof OPEN_SIDE_PANEL
  repository: RepositoryIdentity
}

export type SidePanelMessage = SetSidePanelContextMessage | OpenSidePanelMessage

export interface SidePanelMessageTransport {
  send(message: SidePanelMessage): Promise<unknown>
}

export interface SidePanelApi {
  getOptions?(options: {
    tabId: number
  }): Promise<{ path?: string; enabled?: boolean }>
  setOptions(options: {
    tabId?: number
    path?: string
    enabled: boolean
  }): Promise<void>
  open(options: { tabId: number }): Promise<void>
}

export interface SidePanelMessageSender {
  tab?: { id?: number }
  documentLifecycle?: string
  frameId?: number
}

export interface SidePanelMessageResponse {
  ok: boolean
  error?: string
}

export interface SidePanelNavigationGuard {
  run<T>(tabId: number, operation: () => Promise<T>): Promise<T>
  version(tabId: number): number
  invalidate(tabId: number): void
  markBound(tabId: number, repository: RepositoryIdentity): void
  canOpen(tabId: number, repository: RepositoryIdentity): boolean
  prepareOpen(
    tabId: number,
    repository: RepositoryIdentity,
  ): Promise<SidePanelMessageResponse>
}

export function createSidePanelMessageClient(
  transport: SidePanelMessageTransport,
): {
  sync(repository: RepositoryIdentity | null): Promise<void>
  open(repository: RepositoryIdentity): Promise<void>
} {
  return {
    async sync(repository) {
      await expectSuccessfulResponse(
        transport.send({ type: SET_SIDE_PANEL_CONTEXT, repository }),
      )
    },
    async open(repository) {
      await expectSuccessfulResponse(
        transport.send({ type: OPEN_SIDE_PANEL, repository }),
      )
    },
  }
}

export function createSidePanelMessageHandler(
  sidePanel: SidePanelApi,
  navigation?: SidePanelNavigationGuard,
): (
  message: unknown,
  sender: SidePanelMessageSender,
) => Promise<SidePanelMessageResponse> | undefined {
  return (message, sender) => {
    if (!isSidePanelMessage(message)) {
      return undefined
    }

    if (
      (sender.frameId !== undefined && sender.frameId !== 0) ||
      (sender.documentLifecycle !== undefined &&
        sender.documentLifecycle !== "active")
    ) {
      return Promise.resolve({
        ok: false,
        error: "The repository document is no longer active.",
      })
    }

    const tabId = sender.tab?.id

    if (!Number.isInteger(tabId) || tabId === undefined || tabId < 0) {
      return Promise.resolve({
        ok: false,
        error: "Missing GitHub tab context.",
      })
    }

    if (message.type === SET_SIDE_PANEL_CONTEXT) {
      navigation?.invalidate(tabId)
      const version = navigation?.version(tabId)
      const update = () =>
        setContext(
          sidePanel,
          tabId,
          message.repository,
          () => version === navigation?.version(tabId),
          (bound) => navigation?.markBound(tabId, bound),
        )
      return navigation ? navigation.run(tabId, update) : update()
    }

    const path = createSidePanelPath(message.repository, tabId)
    navigation?.invalidate(tabId)
    if (navigation && !navigation.canOpen(tabId, message.repository)) {
      return navigation.prepareOpen(tabId, message.repository)
    }
    const version = navigation?.version(tabId)
    const configureOptions = () =>
      sidePanel.setOptions(
        navigation
          ? { tabId, enabled: true }
          : {
              tabId,
              path,
              enabled: true,
            },
      )
    const configure = navigation
      ? navigation.run(tabId, configureOptions)
      : configureOptions()
    // A warm tab is already bound and has no outstanding option operations.
    // Keep open in this gesture's synchronous stack, never inside the queue.
    const open = sidePanel.open({ tabId })

    return Promise.all([configure, open]).then(
      () =>
        version === navigation?.version(tabId)
          ? { ok: true }
          : { ok: false, error: "The repository navigation changed." },
      () => ({ ok: false, error: "Chrome could not open the side panel." }),
    )
  }
}

export function createSidePanelPath(
  repository: RepositoryIdentity,
  tabId?: number,
): string {
  const parameters = new URLSearchParams({
    owner: repository.owner,
    repo: repository.repo,
  })
  if (tabId !== undefined) {
    parameters.set("tab", String(tabId))
  }

  return `sidepanel.html?${parameters.toString()}`
}

export function parseSidePanelTabId(value: string | URL): number | null {
  const url = typeof value === "string" ? new URL(value) : value
  const rawTabId = url.searchParams.get("tab")
  if (!rawTabId || !/^\d+$/.test(rawTabId)) return null

  const tabId = Number(rawTabId)
  return Number.isSafeInteger(tabId) ? tabId : null
}

export function parseSidePanelRepository(
  value: string | URL,
): RepositoryIdentity | null {
  const url = typeof value === "string" ? new URL(value) : value
  const repository = {
    owner: url.searchParams.get("owner") ?? "",
    repo: url.searchParams.get("repo") ?? "",
  }

  return isRepositoryIdentity(repository) ? repository : null
}

async function setContext(
  sidePanel: SidePanelApi,
  tabId: number,
  repository: RepositoryIdentity | null,
  isCurrent: () => boolean,
  onBound: (repository: RepositoryIdentity) => void,
): Promise<SidePanelMessageResponse> {
  try {
    if (!isCurrent())
      return { ok: false, error: "The repository navigation changed." }
    const current = repository ? await sidePanel.getOptions?.({ tabId }) : null
    if (!isCurrent())
      return { ok: false, error: "The repository navigation changed." }
    // Discovery does not replace an open job UI. Only explicit Open may rebind.
    const boundUrl = current?.path
      ? new URL(current.path, "https://extension.invalid/")
      : null
    const hasBoundRepository =
      boundUrl?.origin === "https://extension.invalid" &&
      boundUrl?.pathname === "/sidepanel.html" &&
      parseSidePanelTabId(boundUrl) === tabId &&
      parseSidePanelRepository(boundUrl) !== null
    await sidePanel.setOptions(
      repository
        ? hasBoundRepository
          ? { tabId, enabled: true }
          : {
              tabId,
              path: createSidePanelPath(repository, tabId),
              enabled: true,
            }
        : { tabId, enabled: false },
    )
    if (!isCurrent())
      return { ok: false, error: "The repository navigation changed." }
    if (repository)
      onBound(
        hasBoundRepository && boundUrl
          ? parseSidePanelRepository(boundUrl)!
          : repository,
      )
    return { ok: true }
  } catch {
    return { ok: false, error: "Chrome could not update the side panel." }
  }
}

async function expectSuccessfulResponse(
  response: Promise<unknown>,
): Promise<void> {
  const value = await response

  if (!isObject(value) || value.ok !== true) {
    throw new Error(
      isObject(value) && typeof value.error === "string"
        ? value.error
        : "The Peephole side panel could not be reached.",
    )
  }
}

function isSidePanelMessage(value: unknown): value is SidePanelMessage {
  if (!isObject(value)) {
    return false
  }

  if (value.type === SET_SIDE_PANEL_CONTEXT) {
    return value.repository === null || isRepositoryIdentity(value.repository)
  }

  return (
    value.type === OPEN_SIDE_PANEL && isRepositoryIdentity(value.repository)
  )
}

function isRepositoryIdentity(value: unknown): value is RepositoryIdentity {
  return (
    isObject(value) &&
    typeof value.owner === "string" &&
    /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value.owner) &&
    typeof value.repo === "string" &&
    /^[a-z\d_.-]+$/i.test(value.repo)
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
