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
  setOptions(options: {
    tabId: number
    path?: string
    enabled: boolean
  }): Promise<void>
  open(options: { tabId: number }): Promise<void>
}

export interface SidePanelMessageSender {
  tab?: { id?: number }
}

export interface SidePanelMessageResponse {
  ok: boolean
  error?: string
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
): (
  message: unknown,
  sender: SidePanelMessageSender,
) => Promise<SidePanelMessageResponse> | undefined {
  return (message, sender) => {
    if (!isSidePanelMessage(message)) {
      return undefined
    }

    const tabId = sender.tab?.id

    if (!Number.isInteger(tabId) || tabId === undefined || tabId < 0) {
      return Promise.resolve({
        ok: false,
        error: "Missing GitHub tab context.",
      })
    }

    if (message.type === SET_SIDE_PANEL_CONTEXT) {
      return setContext(sidePanel, tabId, message.repository)
    }

    const path = createSidePanelPath(message.repository)
    const configure = sidePanel.setOptions({
      tabId,
      path,
      enabled: true,
    })
    const open = sidePanel.open({ tabId })

    return Promise.all([configure, open]).then(
      () => ({ ok: true }),
      () => ({ ok: false, error: "Chrome could not open the side panel." }),
    )
  }
}

export function createSidePanelPath(repository: RepositoryIdentity): string {
  const parameters = new URLSearchParams({
    owner: repository.owner,
    repo: repository.repo,
  })

  return `sidepanel.html?${parameters.toString()}`
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
): Promise<SidePanelMessageResponse> {
  try {
    await sidePanel.setOptions(
      repository
        ? {
            tabId,
            path: createSidePanelPath(repository),
            enabled: true,
          }
        : { tabId, enabled: false },
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
