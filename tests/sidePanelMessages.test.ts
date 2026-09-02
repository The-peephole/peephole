import { describe, expect, it, vi } from "vitest"

import {
  createSidePanelMessageClient,
  createSidePanelMessageHandler,
  createSidePanelPath,
  OPEN_SIDE_PANEL,
  parseSidePanelRepository,
  SET_SIDE_PANEL_CONTEXT,
  type SidePanelApi,
} from "../core/sidepanel/messages"

describe("side panel messages", () => {
  it("enables the repository-specific panel for a GitHub tab", async () => {
    const sidePanel = createSidePanelApi()
    const handler = createSidePanelMessageHandler(sidePanel)
    const response = await handler(
      {
        type: SET_SIDE_PANEL_CONTEXT,
        repository: { owner: "the-peephole", repo: "peephole" },
      },
      { tab: { id: 17 } },
    )

    expect(response).toEqual({ ok: true })
    expect(sidePanel.setOptions).toHaveBeenCalledWith({
      tabId: 17,
      path: "sidepanel.html?owner=the-peephole&repo=peephole",
      enabled: true,
    })
  })

  it("disables the panel when navigation leaves a repository", async () => {
    const sidePanel = createSidePanelApi()
    const handler = createSidePanelMessageHandler(sidePanel)

    await handler(
      { type: SET_SIDE_PANEL_CONTEXT, repository: null },
      { tab: { id: 17 } },
    )

    expect(sidePanel.setOptions).toHaveBeenCalledWith({
      tabId: 17,
      enabled: false,
    })
  })

  it("opens the panel from the button's user gesture", async () => {
    const sidePanel = createSidePanelApi()
    const handler = createSidePanelMessageHandler(sidePanel)
    const response = await handler(
      {
        type: OPEN_SIDE_PANEL,
        repository: { owner: "react", repo: "react" },
      },
      { tab: { id: 42 } },
    )

    expect(response).toEqual({ ok: true })
    expect(sidePanel.open).toHaveBeenCalledWith({ tabId: 42 })
  })

  it("rejects panel messages without a sender tab", async () => {
    const handler = createSidePanelMessageHandler(createSidePanelApi())
    const response = await handler(
      {
        type: OPEN_SIDE_PANEL,
        repository: { owner: "react", repo: "react" },
      },
      {},
    )

    expect(response).toEqual({
      ok: false,
      error: "Missing GitHub tab context.",
    })
  })

  it("round-trips a repository through the side panel URL", () => {
    const repository = { owner: "the-peephole", repo: "peephole.js" }
    const path = createSidePanelPath(repository)

    expect(
      parseSidePanelRepository(`chrome-extension://example/${path}`),
    ).toEqual(repository)
    expect(
      parseSidePanelRepository("chrome-extension://example/sidepanel.html"),
    ).toBeNull()
  })

  it("surfaces a background failure through the client", async () => {
    const client = createSidePanelMessageClient({
      send: vi
        .fn()
        .mockResolvedValue({ ok: false, error: "Panel unavailable." }),
    })

    await expect(
      client.open({ owner: "react", repo: "react" }),
    ).rejects.toThrow("Panel unavailable.")
  })
})

function createSidePanelApi(): SidePanelApi {
  return {
    setOptions: vi.fn().mockResolvedValue(undefined),
    open: vi.fn().mockResolvedValue(undefined),
  }
}
