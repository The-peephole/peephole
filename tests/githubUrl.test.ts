import { describe, expect, it } from "vitest"

import { parseGitHubRepositoryUrl } from "../utils/githubUrl"

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
