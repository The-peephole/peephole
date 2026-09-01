// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"

import {
  mountPeepholeUi,
  PEEPHOLE_HOST_ID,
} from "../entrypoints/github.content/mountPeepholeUi"

describe("mountPeepholeUi", () => {
  afterEach(() => {
    document.body.innerHTML = ""
  })

  it("mounts inside a GitHub action list without requiring Shadow DOM", () => {
    const actionList = document.createElement("ul")
    document.body.append(actionList)

    const mounted = mountPeepholeUi(
      actionList,
      {
        owner: "react",
        repo: "react",
      },
      async () => ({
        repositoryId: 10270250,
        owner: "react",
        repo: "react",
        defaultBranch: "main",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        homepage: "https://react.dev/",
      }),
    )
    const shadowHost = document.getElementById(PEEPHOLE_HOST_ID)

    expect(mounted.element.tagName).toBe("LI")
    expect(shadowHost?.tagName).toBe("DIV")
    expect(shadowHost?.shadowRoot).toBeNull()
    expect(shadowHost?.querySelector("style")).not.toBeNull()

    mounted.unmount()
    expect(document.getElementById(PEEPHOLE_HOST_ID)).toBeNull()
  })
})
