import { describe, expect, it } from "vitest"

import {
  parseGitHubRepositoryUrl,
  isGitHubRepositoryOverviewUrl,
} from "../utils/githubUrl"

describe("parseGitHubRepositoryUrl", () => {
  it.each([
    ["https://github.com/facebook/react", { owner: "facebook", repo: "react" }],
    [
      "https://github.com/facebook/react/",
      { owner: "facebook", repo: "react" },
    ],
    [
      "https://github.com/facebook/react/issues",
      { owner: "facebook", repo: "react" },
    ],
    [
      "https://github.com/facebook/react/tree/main/packages",
      { owner: "facebook", repo: "react" },
    ],
  ])("parses repository identity from %s", (url, expected) => {
    expect(parseGitHubRepositoryUrl(url)).toEqual(expected)
  })

  it.each([
    "https://github.com/",
    "https://github.com/facebook",
    "https://github.com/settings/profile",
    "https://github.com/orgs/openai",
    "https://example.com/facebook/react",
    "not a URL",
  ])("rejects a non-repository URL: %s", (url) => {
    expect(parseGitHubRepositoryUrl(url)).toBeNull()
  })
})

describe("Repository overview button policy", () => {
  it.each(["", "/", "?tab=readme", "#readme", "/?tab=readme#readme"])(
    "accepts a root with suffix %s",
    (suffix) => {
      expect(
        isGitHubRepositoryOverviewUrl(`https://github.com/owner/repo${suffix}`),
      ).toBe(true)
    },
  )
  it.each([
    "actions",
    "issues",
    "pulls",
    "settings",
    "tree/main",
    "blob/main/README.md",
    "discussions",
    "releases",
    "anything",
  ])("hides the button on %s while retaining repository identity", (path) => {
    const url = `https://github.com/owner/repo/${path}?query=value#fragment`
    expect(isGitHubRepositoryOverviewUrl(url)).toBe(false)
    expect(parseGitHubRepositoryUrl(url)).toEqual({
      owner: "owner",
      repo: "repo",
    })
  })
  it.each([
    "https://github.com/owner//repo",
    "https://github.com/owner/repo//",
    "https://github.com/settings/profile",
    "https://example.com/owner/repo",
    "not a URL",
  ])("rejects a non-overview %s", (url) => {
    expect(isGitHubRepositoryOverviewUrl(url)).toBe(false)
  })
})
