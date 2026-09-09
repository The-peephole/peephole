import { afterEach, describe, expect, it, vi } from "vitest"

import {
  clearStoredPreviewSession,
  getStoredPreviewSession,
  setStoredPreviewSession,
} from "../core/preview/sessionStorage"

describe("preview session storage", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("uses browser.storage.session and never browser.storage.local", async () => {
    const get = vi.fn().mockResolvedValue({
      peepholePreviewSession: {
        token: "session-token",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    })
    const set = vi.fn().mockResolvedValue(undefined)
    const remove = vi.fn().mockResolvedValue(undefined)
    const local = {
      get: vi.fn(() => Promise.reject(new Error("local storage used"))),
      set: vi.fn(() => Promise.reject(new Error("local storage used"))),
      remove: vi.fn(() => Promise.reject(new Error("local storage used"))),
    }
    vi.stubGlobal("browser", {
      storage: { session: { get, set, remove }, local },
    })

    const session = await getStoredPreviewSession()
    await setStoredPreviewSession(session!)
    await clearStoredPreviewSession()

    expect(get).toHaveBeenCalledWith("peepholePreviewSession")
    expect(set).toHaveBeenCalledWith({ peepholePreviewSession: session })
    expect(remove).toHaveBeenCalledWith("peepholePreviewSession")
    expect(local.get).not.toHaveBeenCalled()
    expect(local.set).not.toHaveBeenCalled()
    expect(local.remove).not.toHaveBeenCalled()
  })
})
