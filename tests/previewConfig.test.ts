import { describe, expect, it } from "vitest"

import { isTrustedPreviewArtifactUrl } from "../core/preview/config"

describe("isTrustedPreviewArtifactUrl", () => {
  it("trusts loopback HTTP origins", () => {
    expect(isTrustedPreviewArtifactUrl("http://127.0.0.1:54321/")).toBe(true)
    expect(isTrustedPreviewArtifactUrl("http://localhost:1/index.html")).toBe(
      true,
    )
    expect(isTrustedPreviewArtifactUrl("http://[::1]:8080/")).toBe(true)
  })

  it("rejects non-loopback and non-HTTP origins", () => {
    expect(isTrustedPreviewArtifactUrl("https://attacker.example/")).toBe(
      false,
    )
    expect(isTrustedPreviewArtifactUrl("http://192.168.1.5:8080/")).toBe(
      false,
    )
    expect(isTrustedPreviewArtifactUrl("javascript:alert(1)")).toBe(false)
    expect(isTrustedPreviewArtifactUrl("not a url")).toBe(false)
  })

  it("rejects loopback URLs carrying embedded credentials", () => {
    expect(
      isTrustedPreviewArtifactUrl("http://user:pass@127.0.0.1:8080/"),
    ).toBe(false)
  })
})
