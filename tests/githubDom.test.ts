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
        <ul class="pagehead-actions"><li><button aria-label="Star facebook/react">Star</button></li><li><a aria-label="Fork your own copy of facebook/react">Fork</a></li></ul>
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
        <ul data-testid="repo-header-actions" class="list-style-none d-flex">
          <li>
            <button aria-label="Watch: Participating in facebook/react. Click to change subscription settings.">
              Watch
            </button>
          </li>
          <li><button aria-label="Unstar facebook/react">Star</button></li>
        </ul>
      </header>
    `

    const target = findPeepholeInjectionTarget(document, repository)

    expect(target?.tagName).toBe("UL")
    expect(target?.classList.contains("d-flex")).toBe(true)
  })

  it("omits the action when only body or an arbitrary header is available", () => {
    document.body.innerHTML =
      '<div id="repository-container-header"><a href="/facebook/react">react</a></div>'
    expect(findPeepholeInjectionTarget(document, repository)).toBeNull()
  })
  it.each([
    '<ul><li><button aria-label="Star facebook/react"></button><button aria-label="Fork facebook/react"></button></li></ul>',
    '<ul data-testid="repo-header-actions"><li><button aria-label="Star facebook/react"></button></li></ul>',
    '<ul data-testid="repo-header-actions"><li><button aria-label="Star facebook/react"></button><button aria-label="Star facebook/react"></button></li></ul>',
    '<ul data-testid="repo-header-actions"><li><button aria-label="Star facebook/react-other"></button><button aria-label="Fork facebook/react-other"></button></li></ul>',
    '<ul data-testid="repo-header-actions"><li><button aria-label="Star facebook/react.other"></button><button aria-label="Fork facebook/react.other"></button></li></ul>',
    '<div class="markdown-body"><ul data-testid="repo-header-actions"><li><button aria-label="Star facebook/react"></button><button aria-label="Fork facebook/react"></button></li></ul></div>',
    '<nav><ul data-testid="repo-header-actions"><li><button aria-label="Star facebook/react"></button><button aria-label="Fork facebook/react"></button></li></ul></nav>',
    '<ul data-testid="repo-header-actions"><li><button aria-label="Star facebook/react"></button><button aria-label="Fork other/repo"></button></li></ul>',
    '<ul data-testid="repo-header-actions"><li><button aria-label="Star facebook/react"></button><ul><li><button aria-label="Fork facebook/react"></button></li></ul></li></ul>',
  ])("rejects unrelated, ambiguous or nested action groups: %s", (html) => {
    document.body.innerHTML = html
    expect(findPeepholeInjectionTarget(document, repository)).toBeNull()
  })
  it.each([
    "hidden",
    'aria-hidden="true"',
    'style="display:none"',
    'style="visibility:hidden"',
    "inert",
  ])("rejects a hidden ancestor: %s", (attribute) => {
    document.body.innerHTML = `<div ${attribute}><ul data-testid="repo-header-actions"><li><button aria-label="Star facebook/react"></button><button aria-label="Fork facebook/react"></button></li></ul></div>`
    expect(findPeepholeInjectionTarget(document, repository)).toBeNull()
  })
  it("matches punctuation in repository names literally", () => {
    document.body.innerHTML =
      '<ul data-testid="repo-header-actions"><li><button aria-label="Star facebook/reactXjs"></button><button aria-label="Fork facebook/reactXjs"></button></li></ul>'
    expect(
      findPeepholeInjectionTarget(document, {
        owner: "facebook",
        repo: "react.js",
      }),
    ).toBeNull()
  })
})
