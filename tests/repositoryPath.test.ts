import { describe, expect, it } from "vitest"

import {
  isRepositoryRelativeDirectoryPath,
  isRepositorySafePathSegment,
  joinRepositoryPath,
} from "../core/github/repositoryPath"

describe("isRepositorySafePathSegment", () => {
  it("accepts ordinary directory names", () => {
    expect(isRepositorySafePathSegment("apps")).toBe(true)
    expect(isRepositorySafePathSegment("web-app")).toBe(true)
    expect(isRepositorySafePathSegment("ui_kit")).toBe(true)
    expect(isRepositorySafePathSegment("v1.2")).toBe(true)
  })

  it("rejects '.', '..', and empty segments", () => {
    expect(isRepositorySafePathSegment(".")).toBe(false)
    expect(isRepositorySafePathSegment("..")).toBe(false)
    expect(isRepositorySafePathSegment("")).toBe(false)
  })

  it("rejects segments with unsafe characters", () => {
    expect(isRepositorySafePathSegment("apps/web")).toBe(false)
    expect(isRepositorySafePathSegment("apps*")).toBe(false)
    expect(isRepositorySafePathSegment("apps web")).toBe(false)
    expect(isRepositorySafePathSegment("apps\\web")).toBe(false)
  })
})

describe("isRepositoryRelativeDirectoryPath", () => {
  it("accepts the empty string as the repository root", () => {
    expect(isRepositoryRelativeDirectoryPath("")).toBe(true)
  })

  it("accepts ordinary one- and two-segment paths", () => {
    expect(isRepositoryRelativeDirectoryPath("frontend")).toBe(true)
    expect(isRepositoryRelativeDirectoryPath("apps/web")).toBe(true)
  })

  it("rejects absolute paths", () => {
    expect(isRepositoryRelativeDirectoryPath("/apps/web")).toBe(false)
  })

  it("rejects traversal with '..'", () => {
    expect(isRepositoryRelativeDirectoryPath("../secrets")).toBe(false)
    expect(isRepositoryRelativeDirectoryPath("apps/../secrets")).toBe(false)
  })

  it("rejects backslash traversal", () => {
    expect(isRepositoryRelativeDirectoryPath("apps\\web")).toBe(false)
  })

  it("rejects trailing slashes and empty segments", () => {
    expect(isRepositoryRelativeDirectoryPath("apps/")).toBe(false)
    expect(isRepositoryRelativeDirectoryPath("apps//web")).toBe(false)
  })

  it("rejects paths over the segment bound", () => {
    expect(isRepositoryRelativeDirectoryPath("a/b/c/d/e/f/g/h/i")).toBe(false)
  })
})

describe("joinRepositoryPath", () => {
  it("joins non-empty segments with '/'", () => {
    expect(joinRepositoryPath("apps", "web")).toBe("apps/web")
    expect(joinRepositoryPath("", "apps", "", "web")).toBe("apps/web")
  })
})
