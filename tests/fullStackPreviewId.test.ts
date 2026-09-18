import { describe, expect, it } from "vitest"

import {
  FULLSTACK_PREVIEW_ID_PATTERN,
  createFullStackPreviewId,
} from "../services/fullstack-preview-api/id"
import { ARTIFACT_ID_PATTERN } from "../services/artifactServing/staticFile"

describe("full-stack preview id namespace", () => {
  it("generated ids match the fullstack-<uuid> pattern", () => {
    for (let i = 0; i < 20; i += 1) {
      const id = createFullStackPreviewId()
      expect(id).toMatch(FULLSTACK_PREVIEW_ID_PATTERN)
      expect(id.startsWith("fullstack-")).toBe(true)
    }
  })

  it("fullstack ids never match ARTIFACT_ID_PATTERN, and vice versa", () => {
    const fullstackId = createFullStackPreviewId()
    expect(ARTIFACT_ID_PATTERN.test(fullstackId)).toBe(false)

    const artifactId = `artifact-${crypto.randomUUID()}`
    expect(FULLSTACK_PREVIEW_ID_PATTERN.test(artifactId)).toBe(false)
  })

  it("rejects non-canonical UUID layouts", () => {
    expect(
      FULLSTACK_PREVIEW_ID_PATTERN.test(
        "fullstack-00000000-00000000-0000-0000-00000000",
      ),
    ).toBe(false)
    expect(
      FULLSTACK_PREVIEW_ID_PATTERN.test(
        "fullstack-00000000-0000-0000-0000-00000000000-",
      ),
    ).toBe(false)
  })

  it("distinct calls mint distinct ids", () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => createFullStackPreviewId()),
    )
    expect(ids.size).toBe(50)
  })
})
