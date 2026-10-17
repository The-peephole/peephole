// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { GitHubPageController } from "../entrypoints/github.content/GitHubPageController"
import type { RepositoryIdentity } from "../types/repository"

describe("GitHubPageController theme independence", () => {
  let frames: FrameRequestCallback[]
  const controllers: GitHubPageController[] = []

  beforeEach(() => {
    frames = []
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback)
        return frames.length
      }),
    )
    vi.stubGlobal("cancelAnimationFrame", vi.fn())
    document.head.innerHTML = repositoryMeta("owner/repository-a")
    document.body.innerHTML = repositoryHeader("owner", "repository-a")
  })

  afterEach(() => {
    for (const controller of controllers.splice(0)) controller.stop()
    vi.unstubAllGlobals()
    document.head.innerHTML = ""
    document.body.innerHTML = ""
  })

  it("does not treat a root theme mutation as repository navigation or remount", async () => {
    const location = { href: "https://github.com/owner/repository-a" }
    const repositories: Array<RepositoryIdentity | null> = []
    const mount = vi.fn((target: HTMLElement) => {
      const element = document.createElement("li")
      target.append(element)
      return {
        element,
        isIntact: () => element.isConnected,
        unmount: () => element.remove(),
      }
    })
    const controller = new GitHubPageController(
      document,
      location as Location,
      mount,
      (repository) => repositories.push(repository),
    )

    controller.start()
    document.documentElement.dataset.darkTheme = "dark_dimmed"
    await flushMutations()

    expect(mount).toHaveBeenCalledTimes(1)
    expect(repositories).toEqual([{ owner: "owner", repo: "repository-a" }])
    expect(frames).toHaveLength(0)
    controller.stop()
  })

  it("keeps idempotent mounting through DOM churn and updates on SPA navigation", () => {
    const location = { href: "https://github.com/owner/repository-a" }
    const repositories: Array<RepositoryIdentity | null> = []
    const mount = vi.fn((target: HTMLElement) => {
      const element = document.createElement("li")
      target.append(element)
      return {
        element,
        isIntact: () => element.isConnected,
        unmount: () => element.remove(),
      }
    })
    const controller = new GitHubPageController(
      document,
      location as Location,
      mount,
      (repository) => repositories.push(repository),
    )

    controller.start()
    document.body.append(document.createElement("div"))
    window.dispatchEvent(new Event("turbo:load"))
    runLatestFrame()
    expect(mount).toHaveBeenCalledTimes(1)

    location.href = "https://github.com/owner/repository-b"
    document.head.innerHTML = repositoryMeta("owner/repository-b")
    document.body.innerHTML = repositoryHeader("owner", "repository-b")
    window.dispatchEvent(new Event("turbo:load"))
    runLatestFrame()

    expect(mount).toHaveBeenCalledTimes(2)
    expect(repositories.at(-1)).toEqual({
      owner: "owner",
      repo: "repository-b",
    })
    controller.stop()
  })

  function start(href = "https://github.com/owner/repository-a") {
    const location = { href }
    const contexts = vi.fn()
    const unmounts = vi.fn()
    const mount = vi.fn(
      (target: HTMLElement, repository: RepositoryIdentity) => {
        const element = document.createElement("li")
        element.dataset.peepholeContainer = ""
        element.dataset.repository = `${repository.owner}/${repository.repo}`
        target.append(element)
        return {
          element,
          isIntact: () => element.isConnected,
          unmount: () => {
            unmounts()
            element.remove()
          },
        }
      },
    )
    const controller = new GitHubPageController(
      document,
      location as Location,
      mount,
      contexts,
    )
    controllers.push(controller)
    controller.start()
    const navigate = async (url: string) => {
      location.href = url
      window.dispatchEvent(new Event("turbo:load"))
      await settle()
    }
    return { location, contexts, mount, unmounts, navigate, controller }
  }

  async function settle() {
    for (let turn = 0; turn < 8; turn++) {
      await flushMutations()
      if (!frames.length) return
      runLatestFrame()
    }
    throw new Error("DOM reconciliation did not settle")
  }

  it.each([
    "actions",
    "issues",
    "pulls",
    "settings",
    "tree/main",
    "blob/main/file",
    "discussions",
    "other",
  ])("publishes context on %s without mounting", (path) => {
    const state = start(`https://github.com/owner/repository-a/${path}`)
    expect(state.mount).not.toHaveBeenCalled()
    expect(state.contexts).toHaveBeenCalledExactlyOnceWith({
      owner: "owner",
      repo: "repository-a",
    })
  })

  it("survives 10 root/actions/root/issues cycles with exactly one or zero actions and unchanged context", async () => {
    const state = start()
    const count = () =>
      document.querySelectorAll("[data-peephole-container]").length
    for (let turn = 0; turn < 10; turn++) {
      expect(count()).toBe(1)
      await state.navigate("https://github.com/owner/repository-a/actions")
      expect(count()).toBe(0)
      await state.navigate(
        "https://github.com/owner/repository-a/?tab=readme#readme",
      )
      expect(count()).toBe(1)
      await state.navigate("https://github.com/owner/repository-a/issues")
      expect(count()).toBe(0)
      await state.navigate("https://github.com/owner/repository-a")
    }
    expect(count()).toBe(1)
    expect(state.mount).toHaveBeenCalledTimes(21)
    expect(state.unmounts).toHaveBeenCalledTimes(20)
    expect(state.contexts).toHaveBeenCalledTimes(1)
    expect(frames).toHaveLength(0)
  })

  it("keeps the existing mount for root query/hash and screen state changes", async () => {
    const state = start()
    const element = state.mount.mock.results[0]!.value.element
    for (const suffix of ["?tab=readme", "#readme", "/?x=1#files"]) {
      await state.navigate(`https://github.com/owner/repository-a${suffix}`)
      document.body.append(document.createElement("div"))
      await settle()
    }
    expect(state.mount).toHaveBeenCalledTimes(1)
    expect(state.mount.mock.results[0]!.value.element).toBe(element)
    expect(state.unmounts).not.toHaveBeenCalled()
  })

  it("waits for a delayed valid action group and retires replaced/removed groups", async () => {
    document.body.innerHTML =
      "<header>Repository header without actions</header>"
    const state = start()
    expect(state.mount).not.toHaveBeenCalled()
    document.body.innerHTML = repositoryHeader("owner", "repository-a")
    await settle()
    const first = state.mount.mock.results[0]!.value.element
    const oldList = first.parentElement!
    oldList.replaceWith(oldList.cloneNode(false))
    await settle()
    expect(state.unmounts).toHaveBeenCalledTimes(1)
    expect(state.mount).toHaveBeenCalledTimes(1) // empty replacement is not valid
    document.body.innerHTML = repositoryHeader("owner", "repository-a")
    await settle()
    expect(state.mount).toHaveBeenCalledTimes(2)
    document.querySelector("ul")!.remove()
    await settle()
    expect(state.unmounts).toHaveBeenCalledTimes(2)
    expect(document.querySelector("[data-peephole-container]")).toBeNull()
    expect(frames).toHaveLength(0)
  })

  it("revalidates a connected container after hiding, identity change or relocation", async () => {
    const state = start()
    const list = document.querySelector<HTMLElement>("ul")!
    list.hidden = true
    await settle()
    expect(state.unmounts).toHaveBeenCalledTimes(1)
    list.hidden = false
    await settle()
    expect(state.mount).toHaveBeenCalledTimes(2)
    const element = state.mount.mock.results.at(-1)!.value.element
    document.body.append(element) // still connected, but no longer in the action group
    await settle()
    expect(state.unmounts).toHaveBeenCalledTimes(2)
    expect(state.mount).toHaveBeenCalledTimes(3)
    list.querySelector("button")!.setAttribute("aria-label", "Star owner/wrong")
    await settle()
    expect(state.unmounts).toHaveBeenCalledTimes(3)
    expect(document.querySelector("[data-peephole-container]")).toBeNull()
  })

  it("waits for repository B's actual actions even when its metadata arrives before the DOM", async () => {
    const state = start()
    document.head.innerHTML = repositoryMeta("owner/repository-b")
    await state.navigate("https://github.com/owner/repository-b")
    expect(state.unmounts).toHaveBeenCalledTimes(1)
    expect(state.mount).toHaveBeenCalledTimes(1)
    expect(state.contexts).toHaveBeenLastCalledWith({
      owner: "owner",
      repo: "repository-b",
    })
    document.body.innerHTML = repositoryHeader("owner", "repository-b")
    await settle()
    expect(state.mount).toHaveBeenCalledTimes(2)
    expect(state.mount.mock.calls.at(-1)![1]).toEqual({
      owner: "owner",
      repo: "repository-b",
    })
    expect(document.querySelectorAll("[data-peephole-container]")).toHaveLength(
      1,
    )
    await state.navigate("https://github.com/settings/profile")
    expect(state.contexts).toHaveBeenLastCalledWith(null)
    expect(document.querySelector("[data-peephole-container]")).toBeNull()
  })

  it("batches a mutation burst into one frame and cancels pending work on stop", async () => {
    const state = start()
    for (let index = 0; index < 50; index++)
      document.body.append(document.createElement("span"))
    await flushMutations()
    expect(frames).toHaveLength(1)
    await settle()
    expect(state.mount).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event("pjax:end"))
    state.controller.stop()
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1)
    expect(state.unmounts).toHaveBeenCalledTimes(1)
  })

  function runLatestFrame(): void {
    const frame = frames.shift()
    if (!frame) throw new Error("Repository sync frame was not scheduled.")
    frame(0)
  }

  it("recovers when repository metadata is the last attribute to arrive", async () => {
    document.head.innerHTML = ""
    document.body.innerHTML = repositoryHeader("owner", "repository-a")
      .replace('id="repository-container-header"', "")
      .replace('class="pagehead-actions"', 'data-testid="repo-header-actions"')
    const state = start()
    expect(state.mount).not.toHaveBeenCalled()
    const metadata = document.createElement("meta")
    metadata.name = "octolytics-dimension-repository_nwo"
    document.head.append(metadata)
    await settle()
    expect(state.mount).not.toHaveBeenCalled()
    metadata.content = "owner/repository-a"
    await settle()
    expect(state.mount).toHaveBeenCalledTimes(1)
    expect(state.contexts).toHaveBeenLastCalledWith({
      owner: "owner",
      repo: "repository-a",
    })
  })
})

function repositoryMeta(repository: string): string {
  return `<meta name="octolytics-dimension-repository_nwo" content="${repository}">`
}

function repositoryHeader(owner: string, repo: string): string {
  return `<div id="repository-container-header"><a href="/${owner}/${repo}">${repo}</a><ul class="pagehead-actions"><li><button aria-label="Star ${owner}/${repo}">Star</button></li><li><a aria-label="Fork ${owner}/${repo}">Fork</a></li></ul></div>`
}

async function flushMutations(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
