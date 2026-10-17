// @vitest-environment jsdom

import { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GitHubPageController } from "../entrypoints/github.content/GitHubPageController"
import {
  mountPeepholeUi,
  PEEPHOLE_HOST_ID,
  type MountedPeepholeUi,
} from "../entrypoints/github.content/mountPeepholeUi"
import type { RepositoryIdentity } from "../types/repository"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true
const repository = { owner: "owner", repo: "repo" }
const logo = "chrome-extension://peephole/icons/peephole-32.png"
const actions = (repo = "repo") =>
  `<ul data-testid="repo-header-actions"><li><button aria-label="Watch: Participating in owner/${repo}. Click to change settings.">Watch</button></li><li><a aria-label="Fork your own copy of owner/${repo}">Fork</a></li><li><button aria-label="Star owner/${repo}">Star</button></li></ul>`

describe("mountPeepholeUi", () => {
  const units = new Set<MountedPeepholeUi>()
  const controllers: GitHubPageController[] = []
  let frames: FrameRequestCallback[]
  beforeEach(() => {
    frames = []
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal("cancelAnimationFrame", vi.fn())
    document.head.innerHTML =
      '<meta name="octolytics-dimension-repository_nwo" content="owner/repo">'
    document.body.innerHTML = actions()
  })
  afterEach(() => {
    act(() => {
      for (const controller of controllers.splice(0)) controller.stop()
      for (const unit of units) unit.unmount()
      units.clear()
    })
    vi.unstubAllGlobals()
    document.head.innerHTML = ""
    document.body.innerHTML = ""
  })
  function mount(
    target: HTMLElement,
    repo: RepositoryIdentity,
    open = vi.fn().mockResolvedValue(undefined),
  ) {
    const unit = mountPeepholeUi(target, repo, open, logo)
    units.add(unit)
    return {
      ...unit,
      unmount: () => {
        unit.unmount()
        units.delete(unit)
      },
    }
  }
  async function settle() {
    for (let turn = 0; turn < 8; turn++) {
      await act(async () => {
        await Promise.resolve()
        frames.shift()?.(0)
      })
      if (!frames.length) return
    }
    throw new Error("React/DOM observer loop did not settle")
  }
  it("mounts as the adjacent list item in normal layout and releases the React root", async () => {
    const actionList = document.querySelector("ul")!
    let mounted!: MountedPeepholeUi
    await act(async () => {
      mounted = mount(actionList, repository)
    })
    const host = document.getElementById(PEEPHOLE_HOST_ID)!
    expect(mounted.element.tagName).toBe("LI")
    expect(mounted.element.parentElement).toBe(actionList)
    expect(mounted.element.previousElementSibling?.textContent).toBe("Star")
    expect(host.tagName).toBe("DIV")
    expect(host.shadowRoot).toBeNull()
    expect(host.querySelector("style")).not.toBeNull()
    expect(mounted.element.style.position).toBe("relative")
    expect(mounted.element.style.right).toBe("")
    expect(mounted.element.style.top).toBe("")
    expect(mounted.element.style.flex).toBe("0 0 auto")
    expect(mounted.isIntact()).toBe(true)
    act(() => mounted.unmount())
    expect(document.getElementById(PEEPHOLE_HOST_ID)).toBeNull()
    expect(mounted.isIntact()).toBe(false)
  })
  it("rejects body, arbitrary header and unverified lists instead of floating", () => {
    for (const target of [
      document.body,
      document.createElement("header"),
      document.createElement("ul"),
    ]) {
      expect(() => mount(target, repository)).toThrow(
        "visible repository action list",
      )
    }
    expect(document.querySelector("[data-peephole-container]")).toBeNull()
  })
  it("cleans up a still-connected container whose inner host was removed, then remounts exactly once", async () => {
    const open = vi.fn().mockResolvedValue(undefined)
    const mountSpy = vi.fn((target: HTMLElement, repo: RepositoryIdentity) =>
      mount(target, repo, open),
    )
    const controller = new GitHubPageController(
      document,
      { href: "https://github.com/owner/repo" } as Location,
      mountSpy,
    )
    controllers.push(controller)
    await act(async () => controller.start())
    const oldButton =
      document.querySelector<HTMLButtonElement>(".peephole__trigger")!
    const container = document.querySelector("[data-peephole-container]")!
    document.getElementById(PEEPHOLE_HOST_ID)!.remove()
    expect(container.isConnected).toBe(true)
    await settle()
    expect(mountSpy).toHaveBeenCalledTimes(2)
    expect(container.isConnected).toBe(false)
    expect(units.size).toBe(1)
    expect(document.querySelectorAll(".peephole__trigger")).toHaveLength(1)
    await act(async () => oldButton.click())
    expect(open).not.toHaveBeenCalled()
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".peephole__trigger")!.click(),
    )
    expect(open).toHaveBeenCalledExactlyOnceWith(repository)
    await settle()
    expect(mountSpy).toHaveBeenCalledTimes(2)
  })
  it("retains context through subpages and binds the live button to B after 10 SPA cycles and list replacement", async () => {
    const open = vi.fn().mockResolvedValue(undefined)
    const context = vi.fn()
    const location = { href: "https://github.com/owner/repo" }
    const controller = new GitHubPageController(
      document,
      location as Location,
      (target, repo) => mount(target, repo, open),
      context,
    )
    controllers.push(controller)
    await act(async () => controller.start())
    const oldButton =
      document.querySelector<HTMLButtonElement>(".peephole__trigger")!
    for (let index = 0; index < 10; index++) {
      for (const path of ["/actions", "", "/issues", "/?tab=readme#readme"]) {
        location.href = `https://github.com/owner/repo${path}`
        window.dispatchEvent(new Event("turbo:load"))
        await settle()
        expect(document.querySelectorAll(".peephole__trigger")).toHaveLength(
          path === "/actions" || path === "/issues" ? 0 : 1,
        )
      }
    }
    expect(context).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
    document.head.querySelector("meta")!.setAttribute("content", "owner/repo-b")
    document.body.innerHTML = actions("repo-b")
    location.href = "https://github.com/owner/repo-b"
    window.dispatchEvent(new Event("turbo:load"))
    await settle()
    expect(units.size).toBe(1)
    expect(document.querySelectorAll(".peephole__trigger")).toHaveLength(1)
    await act(async () => oldButton.click())
    expect(open).not.toHaveBeenCalled()
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".peephole__trigger")!.click(),
    )
    expect(open).toHaveBeenCalledExactlyOnceWith({
      owner: "owner",
      repo: "repo-b",
    })
    expect(frames).toHaveLength(0)
  })
})
