// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { GitHubPageController } from "../entrypoints/github.content/GitHubPageController"
import type { RepositoryIdentity } from "../types/repository"

describe("GitHubPageController theme independence", () => {
  let frames: FrameRequestCallback[]

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
      return { element, unmount: () => element.remove() }
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
      return { element, unmount: () => element.remove() }
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

  function runLatestFrame(): void {
    const frame = frames.shift()
    if (!frame) throw new Error("Repository sync frame was not scheduled.")
    frame(0)
  }
})

function repositoryMeta(repository: string): string {
  return `<meta name="octolytics-dimension-repository_nwo" content="${repository}">`
}

function repositoryHeader(owner: string, repo: string): string {
  return `<div id="repository-container-header"><ul class="pagehead-actions"><li><a href="/${owner}/${repo}">${repo}</a></li></ul></div>`
}

async function flushMutations(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
