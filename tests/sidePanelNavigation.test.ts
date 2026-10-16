// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest"
import { subscribeToRepositoryReturn } from "../core/sidepanel/contentLifecycle"
import { createSidePanelNavigation } from "../core/sidepanel/navigation"
import {
  OPEN_SIDE_PANEL,
  SET_SIDE_PANEL_CONTEXT,
  type SidePanelApi,
} from "../core/sidepanel/messages"

const repo = { owner: "The-peephole", repo: "peephole" }
const other = { owner: "The-peephole", repo: "fixture" }
const sender = (id = 17) => ({
  tab: { id },
  frameId: 0,
  documentLifecycle: "active",
})
function fixture() {
  const options = new Map<number, { path?: string; enabled?: boolean }>()
  const api = {
    getOptions: vi.fn(
      async ({ tabId }: { tabId: number }) => options.get(tabId) ?? {},
    ),
    setOptions: vi.fn(
      async (value: { tabId?: number; path?: string; enabled?: boolean }) => {
        if (value.tabId !== undefined)
          options.set(value.tabId, { ...options.get(value.tabId), ...value })
      },
    ),
    open: vi.fn().mockResolvedValue(undefined),
  } satisfies SidePanelApi
  return { api, options }
}
describe("Sidepanel navigation policy", () => {
  it("reports a BFCache repository return without remounting its button or opening a panel", () => {
    const onReturn = vi.fn(),
      unsubscribe = subscribeToRepositoryReturn(window, onReturn)
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: false }),
    )
    expect(onReturn).not.toHaveBeenCalled()
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    )
    expect(onReturn).toHaveBeenCalledTimes(1)
    unsubscribe()
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    )
    expect(onReturn).toHaveBeenCalledTimes(1)
  })
  it("disables the global fallback and opens only a preconfigured tab synchronously from a click", async () => {
    const { api } = fixture()
    const nav = createSidePanelNavigation(api)
    await nav.initialize()
    expect(api.setOptions).toHaveBeenCalledWith({ enabled: false })
    await nav.handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: repo },
      sender(),
    )
    const result = nav.handleMessage(
      { type: OPEN_SIDE_PANEL, repository: repo },
      sender(),
    )
    expect(api.open).toHaveBeenCalledWith({ tabId: 17 }) // no awaited work burns the gesture
    expect(await result).toEqual({ ok: true })
  })
  it("hides on an external full navigation, preserves the path and never automatically reopens on return", async () => {
    const { api, options } = fixture()
    const nav = createSidePanelNavigation(api)
    await nav.handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: repo },
      sender(),
    )
    await nav.handleMessage(
      { type: OPEN_SIDE_PANEL, repository: repo },
      sender(),
    )
    const path = options.get(17)!.path
    await nav.onUpdated(17, { status: "loading" }) // no URL or tabs permission
    expect(options.get(17)).toMatchObject({ path, enabled: false })
    await nav.handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: repo },
      sender(),
    )
    expect(options.get(17)).toMatchObject({ path, enabled: true })
    expect(api.open).toHaveBeenCalledTimes(1)
    // Manual close has no auto-open intent. Complete/status and SPA sync do not open.
    await nav.onUpdated(17, { status: "complete" })
    await nav.onUpdated(17, {})
    await nav.handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: repo },
      sender(),
    )
    expect(api.open).toHaveBeenCalledTimes(1)
  })
  it("keeps tabs independent and leaves the bound repository unchanged on SPA discovery", async () => {
    const { api, options } = fixture()
    const nav = createSidePanelNavigation(api)
    await nav.handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: repo },
      sender(17),
    )
    await nav.handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: other },
      sender(42),
    )
    const before = options.get(42)
    const path = options.get(17)!.path
    await nav.handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: other },
      sender(17),
    )
    expect(options.get(17)!.path).toBe(path)
    await nav.onUpdated(17, { status: "loading" })
    expect(options.get(42)).toEqual(before)
    expect(api.open).not.toHaveBeenCalled()
  })
  it("restores Chrome-owned context after worker restart; a cold or changed context requires a fresh second click", async () => {
    const { api, options } = fixture()
    await createSidePanelNavigation(api).handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: repo },
      sender(),
    )
    const nav = createSidePanelNavigation(api)
    await nav.initialize()
    await nav.handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: other },
      sender(),
    )
    expect(options.get(17)!.path).toContain("repo=peephole&")
    const prepare = await nav.handleMessage(
      { type: OPEN_SIDE_PANEL, repository: other },
      sender(),
    )
    expect(prepare?.error).toContain("Click Peephole again")
    expect(api.open).not.toHaveBeenCalled()
    expect(
      await nav.handleMessage(
        { type: OPEN_SIDE_PANEL, repository: other },
        sender(),
      ),
    ).toEqual({ ok: true })
    expect(api.open).toHaveBeenCalledTimes(1)
    expect(options.get(17)!.path).toContain("repo=fixture&")
  })
  it("refuses a stale context response after navigation", async () => {
    const { api, options } = fixture()
    const nav = createSidePanelNavigation(api)
    let resolve!: (value: { path?: string; enabled?: boolean }) => void
    api.getOptions.mockImplementationOnce(
      () => new Promise((r) => (resolve = r)),
    )
    const sync = nav.handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: repo },
      sender(),
    )
    await nav.onUpdated(17, { status: "loading" })
    resolve({})
    expect((await sync)?.ok).toBe(false)
    expect(options.get(17)!.enabled).toBe(false)
  })
  it("does not apply a delayed external hide after repository return", async () => {
    const { api, options } = fixture()
    let release!: () => void
    const nav = createSidePanelNavigation(
      api,
      () => new Promise((r) => (release = r)),
    )
    const hide = nav.onUpdated(17, { status: "loading" })
    await nav.handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: repo },
      sender(),
    )
    release()
    await hide
    expect(options.get(17)!.enabled).toBe(true)
  })
  it("keeps the existing panel/context on unsafe admission or persistence failure", async () => {
    const { api, options } = fixture()
    const nav = createSidePanelNavigation(api, async () => {
      throw new Error("Unacknowledged controls")
    })
    await nav.handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: repo },
      sender(),
    )
    const before = options.get(17)
    await expect(nav.onUpdated(17, { status: "loading" })).rejects.toThrow(
      "Unacknowledged",
    )
    const result = await nav.handleMessage(
      { type: OPEN_SIDE_PANEL, repository: other },
      sender(),
    )
    expect(result?.ok).toBe(false)
    expect(options.get(17)).toEqual(before)
    expect(api.open).not.toHaveBeenCalled()
  })
  it("ignores cached or embedded documents", async () => {
    const { api } = fixture()
    const nav = createSidePanelNavigation(api)
    for (const context of [
      { ...sender(), documentLifecycle: "cached" },
      { ...sender(), frameId: 2 },
    ]) {
      expect(
        (
          await nav.handleMessage(
            { type: SET_SIDE_PANEL_CONTEXT, repository: repo },
            context,
          )
        )?.ok,
      ).toBe(false)
    }
    expect(api.setOptions).not.toHaveBeenCalled()
  })
})
