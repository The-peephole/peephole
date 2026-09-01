// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest"

import {
  findPeepholeInjectionTarget,
  getRepositoryFromGitHubPage,
} from "../entrypoints/github.content/githubDom"

describe("GitHub repository page detection", () => {
  beforeEach(() => {
    document.head.innerHTML = ""
    document.body.innerHTML = ""
  })

  it("accepts repository metadata that matches the URL", () => {
    document.head.innerHTML = `
      <meta name="octolytics-dimension-repository_nwo" content="facebook/react">
    `

    expect(
      getRepositoryFromGitHubPage(
        document,
        "https://github.com/facebook/react/issues",
      ),
    ).toEqual({ owner: "facebook", repo: "react" })
  })

  it("rejects stale repository metadata after navigation", () => {
    document.head.innerHTML = `
      <meta name="octolytics-dimension-repository_nwo" content="facebook/react">
    `

    expect(
      getRepositoryFromGitHubPage(
        document,
        "https://github.com/openai/openai-node",
      ),
    ).toBeNull()
  })

  it("uses the repository header as a metadata fallback", () => {
    document.body.innerHTML = `
      <div id="repository-container-header">
        <a href="/facebook/react">react</a>
      </div>
    `

    expect(
      getRepositoryFromGitHubPage(
        document,
        "https://github.com/facebook/react/tree/main",
      ),
    ).toEqual({ owner: "facebook", repo: "react" })
  })

  it("does not treat a GitHub application route as a repository", () => {
    document.body.innerHTML = `
      <div id="repository-container-header">
        <a href="/settings/profile">profile</a>
      </div>
    `

    expect(
      getRepositoryFromGitHubPage(
        document,
        "https://github.com/settings/profile",
      ),
    ).toBeNull()
  })
})

describe("GitHub injection target", () => {
  const repository = { owner: "facebook", repo: "react" }

  beforeEach(() => {
    document.body.innerHTML = ""
  })

  it("prefers the repository action list", () => {
    document.body.innerHTML = `
      <div id="repository-container-header">
        <ul class="pagehead-actions"></ul>
      </div>
    `

    expect(findPeepholeInjectionTarget(document, repository)?.tagName).toBe(
      "UL",
    )
  })

  it("uses GitHub's current visible repository action list", () => {
    document.body.innerHTML = `
      <div id="repository-container-header" style="display: none">
        <ul class="pagehead-actions"></ul>
      </div>
      <header>
        <ul class="list-style-none d-flex">
          <li>
            <button aria-label="Watch: Participating in facebook/react. Click to change subscription settings.">
              Watch
            </button>
          </li>
        </ul>
      </header>
    `

    const target = findPeepholeInjectionTarget(document, repository)

    expect(target?.tagName).toBe("UL")
    expect(target?.classList.contains("d-flex")).toBe(true)
  })

  it("falls back to a floating body mount when GitHub has no action target", () => {
    expect(findPeepholeInjectionTarget(document, repository)).toBe(
      document.body,
    )
  })
})
