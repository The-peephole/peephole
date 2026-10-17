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
      async (value: Parameters<SidePanelApi["setOptions"]>[0]) => {
        if (value.tabId !== undefined)
          options.set(value.tabId, { ...options.get(value.tabId), ...value })
      },
    ),
    open: vi.fn().mockResolvedValue(undefined),
  } satisfies SidePanelApi
  return { api, options }
}

async function flushCallbacks() {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
}

// Applying options and resolving their Promise are controlled together, in any
// order the test chooses. The fake does not grant Chrome cross-call FIFO order.
function delayWrites({ api, options }: ReturnType<typeof fixture>) {
  const pending: {
    value: Parameters<SidePanelApi["setOptions"]>[0]
    finish: () => void
    reject: () => void
    settled: boolean
  }[] = []
  const applied: Parameters<SidePanelApi["setOptions"]>[0][] = []
  api.setOptions.mockImplementation(
    (value) =>
      new Promise<void>((resolve, reject) => {
        const write = {
          value,
          settled: false,
          finish() {
            if (write.settled) throw new Error("Write already settled")
            write.settled = true
            if (value.tabId !== undefined)
              options.set(value.tabId, {
                ...options.get(value.tabId),
                ...value,
              })
            applied.push(value)
            resolve()
          },
          reject() {
            write.settled = true
            reject(new Error("Chrome rejected options"))
          },
        }
        pending.push(write)
      }),
  )
  return {
    pending,
    applied,
    async newestFirst() {
      await flushCallbacks()
      for (;;) {
        const write = pending.findLast((entry) => !entry.settled)
        if (!write) return
        write.finish()
        await flushCallbacks()
      }
    },
  }
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
    const hide = nav.onUpdated(17, { status: "loading" })
    resolve({})
    expect((await sync)?.ok).toBe(false)
    await hide
    expect(options.get(17)!.enabled).toBe(false)
  })
  it("keeps the latest hide when old enable completion is delayed, and rejects stale success", async () => {
    const state = fixture()
    const writes = delayWrites(state)
    const nav = createSidePanelNavigation(state.api)
    const sync = nav.handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: repo },
      sender(),
    )
    await flushCallbacks()
    expect(writes.pending).toHaveLength(1)
    const hide = nav.onUpdated(17, { status: "loading" })
    await flushCallbacks()
    expect(writes.pending).toHaveLength(1) // hide cannot overtake the old write
    // Finish the newest submitted API call first, including any later calls.
    await writes.newestFirst()
    expect((await sync)?.ok).toBe(false)
    await hide
    expect(state.options.get(17)?.enabled).toBe(false)
    expect(writes.applied.map((write) => write.enabled)).toEqual([true, false])
    expect(state.api.open).not.toHaveBeenCalled()
  })
  it("serializes delayed repository A binding before the latest explicit repository B intent", async () => {
    const state = fixture()
    const writes = delayWrites(state)
    const nav = createSidePanelNavigation(state.api)
    const first = nav.handleMessage(
      { type: OPEN_SIDE_PANEL, repository: repo },
      sender(),
    )
    await flushCallbacks()
    const latest = nav.handleMessage(
      { type: OPEN_SIDE_PANEL, repository: other },
      sender(),
    )
    await writes.newestFirst()
    expect((await first)?.error).toContain("Navigation changed")
    expect((await latest)?.error).toContain("Click Peephole again")
    expect(state.options.get(17)?.path).toContain("repo=fixture&")
    expect(state.api.open).not.toHaveBeenCalled()
    const click = nav.handleMessage(
      { type: OPEN_SIDE_PANEL, repository: other },
      sender(),
    )
    expect(state.api.open).toHaveBeenCalledTimes(1)
    await writes.newestFirst()
    expect(await click).toEqual({ ok: true })
  })
  it("ignores a delayed getOptions for A after an explicit B context arrives", async () => {
    const state = fixture()
    const writes = delayWrites(state)
    let release!: (value: { path?: string; enabled?: boolean }) => void
    state.api.getOptions.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    )
    const nav = createSidePanelNavigation(state.api)
    const first = nav.handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: repo },
      sender(),
    )
    const latest = nav.handleMessage(
      { type: OPEN_SIDE_PANEL, repository: other },
      sender(),
    )
    await flushCallbacks()
    release({})
    await writes.newestFirst()
    expect((await first)?.ok).toBe(false)
    expect((await latest)?.error).toContain("Click Peephole again")
    expect(state.options.get(17)?.path).toContain("repo=fixture&")
    expect(writes.applied).toHaveLength(1)
  })
  it("re-enables the retained path when repository return overtakes an in-flight hide", async () => {
    const state = fixture()
    const nav = createSidePanelNavigation(state.api)
    await nav.handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: repo },
      sender(),
    )
    const path = state.options.get(17)?.path
    const writes = delayWrites(state)
    const hide = nav.onUpdated(17, { status: "loading" })
    await flushCallbacks()
    expect(writes.pending).toHaveLength(1)
    const sync = nav.handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: other },
      sender(),
    )
    await writes.newestFirst()
    await hide
    expect(await sync).toEqual({ ok: true })
    expect(state.options.get(17)).toMatchObject({ path, enabled: true })
    expect(writes.applied.map((write) => write.enabled)).toEqual([false, true])
    expect(state.api.open).not.toHaveBeenCalled()
  })
  it("lets tab B finish while tab A is delayed and invalidated", async () => {
    const state = fixture()
    const writes = delayWrites(state)
    const nav = createSidePanelNavigation(state.api)
    const a = nav.handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: repo },
      sender(17),
    )
    await flushCallbacks()
    const b = nav.handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: other },
      sender(42),
    )
    await flushCallbacks()
    writes.pending.find((write) => write.value.tabId === 42)!.finish()
    expect(await b).toEqual({ ok: true })
    const before = state.options.get(42)
    expect(state.options.has(17)).toBe(false)
    const hide = nav.onUpdated(17, { status: "loading" })
    await writes.newestFirst()
    expect((await a)?.ok).toBe(false)
    await hide
    expect(state.options.get(42)).toEqual(before)
    expect(state.options.get(17)?.enabled).toBe(false)
  })
  it("opens a warm click synchronously but does not report success after navigation invalidates it", async () => {
    const state = fixture()
    const nav = createSidePanelNavigation(state.api)
    await nav.handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: repo },
      sender(),
    )
    const writes = delayWrites(state)
    const click = nav.handleMessage(
      { type: OPEN_SIDE_PANEL, repository: repo },
      sender(),
    )
    expect(state.api.open).toHaveBeenCalledTimes(1)
    expect(writes.pending).toHaveLength(1)
    const hide = nav.onUpdated(17, { status: "loading" })
    await writes.newestFirst()
    expect((await click)?.ok).toBe(false)
    await hide
    expect(state.options.get(17)?.enabled).toBe(false)
    expect(state.api.open).toHaveBeenCalledTimes(1)
  })
  it("does not open a cached A path while a rebind to B is still applying", async () => {
    const state = fixture()
    const nav = createSidePanelNavigation(state.api)
    await nav.handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: repo },
      sender(),
    )
    const writes = delayWrites(state)
    const rebind = nav.handleMessage(
      { type: OPEN_SIDE_PANEL, repository: other },
      sender(),
    )
    await flushCallbacks()
    expect(writes.pending).toHaveLength(1)
    const back = nav.handleMessage(
      { type: OPEN_SIDE_PANEL, repository: repo },
      sender(),
    )
    expect(state.api.open).not.toHaveBeenCalled()
    await writes.newestFirst()
    expect((await rebind)?.error).toContain("Navigation changed")
    expect((await back)?.error).toContain("Click Peephole again")
    expect(state.options.get(17)?.path).toContain("repo=peephole&")
    const click = nav.handleMessage(
      { type: OPEN_SIDE_PANEL, repository: repo },
      sender(),
    )
    expect(state.api.open).toHaveBeenCalledTimes(1)
    await writes.newestFirst()
    expect(await click).toEqual({ ok: true })
  })
  it("skips obsolete queued discovery and recovers the queue after an API rejection", async () => {
    const state = fixture()
    const writes = delayWrites(state)
    const nav = createSidePanelNavigation(state.api)
    const first = nav.handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: repo },
      sender(),
    )
    await flushCallbacks()
    const obsolete = nav.handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: other },
      sender(),
    )
    const hide = nav.onUpdated(17, { status: "loading" })
    writes.pending[0]!.reject()
    await writes.newestFirst()
    expect((await first)?.ok).toBe(false)
    expect((await obsolete)?.ok).toBe(false)
    await hide
    expect(state.api.getOptions).toHaveBeenCalledTimes(1)
    expect(writes.applied).toEqual([{ tabId: 17, enabled: false }])
    const back = nav.handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: repo },
      sender(),
    )
    await writes.newestFirst()
    expect(await back).toEqual({ ok: true })
    expect(state.options.get(17)?.enabled).toBe(true)
  })
  it("does not trust an old warm cache after a rebind is invalidated by external navigation", async () => {
    const state = fixture()
    const nav = createSidePanelNavigation(state.api)
    await nav.handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: repo },
      sender(),
    )
    const writes = delayWrites(state)
    const rebind = nav.handleMessage(
      { type: OPEN_SIDE_PANEL, repository: other },
      sender(),
    )
    await flushCallbacks()
    const hide = nav.onUpdated(17, { status: "loading" })
    await writes.newestFirst()
    expect((await rebind)?.ok).toBe(false)
    await hide
    expect(state.options.get(17)?.path).toContain("repo=fixture&")
    const back = nav.handleMessage(
      { type: OPEN_SIDE_PANEL, repository: repo },
      sender(),
    )
    expect(state.api.open).not.toHaveBeenCalled()
    await writes.newestFirst()
    expect((await back)?.error).toContain("Click Peephole again")
    expect(state.options.get(17)?.path).toContain("repo=peephole&")
  })
  it("continues a queued repository return after hide rejects without retrying it", async () => {
    const state = fixture()
    const nav = createSidePanelNavigation(state.api)
    const writes = delayWrites(state)
    const hide = nav.onUpdated(17, { status: "loading" })
    const rejected = expect(hide).rejects.toThrow("Chrome rejected options")
    await flushCallbacks()
    const back = nav.handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: repo },
      sender(),
    )
    writes.pending[0]!.reject()
    await writes.newestFirst()
    await rejected
    expect(await back).toEqual({ ok: true })
    expect(writes.pending).toHaveLength(2)
    expect(state.options.get(17)?.enabled).toBe(true)
    expect(state.api.open).not.toHaveBeenCalled()
  })
  it("checks the click version even when open resolves after its configuration and a navigation", async () => {
    const state = fixture()
    const nav = createSidePanelNavigation(state.api)
    await nav.handleMessage(
      { type: SET_SIDE_PANEL_CONTEXT, repository: repo },
      sender(),
    )
    let opened!: () => void
    state.api.open.mockImplementationOnce(
      () => new Promise<void>((resolve) => (opened = resolve)),
    )
    const click = nav.handleMessage(
      { type: OPEN_SIDE_PANEL, repository: repo },
      sender(),
    )
    expect(state.api.open).toHaveBeenCalledTimes(1)
    await flushCallbacks()
    await nav.onUpdated(17, { status: "loading" })
    opened()
    expect((await click)?.ok).toBe(false)
    expect(state.options.get(17)?.enabled).toBe(false)
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
