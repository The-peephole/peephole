import { describe, expect, it } from "vitest"

import {
  isTrustedPreviewArtifactUrl,
  parsePreviewArtifactBaseDomain,
  getPreviewFrameSrc,
} from "../core/preview/config"

describe("isTrustedPreviewArtifactUrl", () => {
  it("trusts only the IPv4 origin allowed by the extension CSP", () => {
    expect(isTrustedPreviewArtifactUrl("http://127.0.0.1:54321/")).toBe(true)
    expect(isTrustedPreviewArtifactUrl("http://localhost:1/index.html")).toBe(
      false,
    )
    expect(isTrustedPreviewArtifactUrl("http://[::1]:8080/")).toBe(false)
  })

  it("rejects non-loopback and non-HTTP origins", () => {
    expect(isTrustedPreviewArtifactUrl("https://attacker.example/")).toBe(false)
    expect(isTrustedPreviewArtifactUrl("http://192.168.1.5:8080/")).toBe(false)
    expect(isTrustedPreviewArtifactUrl("javascript:alert(1)")).toBe(false)
    expect(isTrustedPreviewArtifactUrl("not a url")).toBe(false)
  })

  it("rejects loopback URLs carrying embedded credentials", () => {
    expect(
      isTrustedPreviewArtifactUrl("http://user:pass@127.0.0.1:8080/"),
    ).toBe(false)
  })
})

const productionDomain = "3.34.33.24.nip.io"
const artifactId = "artifact-12345678-1234-1234-1234-123456789abc"
const productionHost = `${artifactId}.${productionDomain}`

describe("parsePreviewArtifactBaseDomain", () => {
  it("accepts and normalizes DNS roots", () => {
    expect(parsePreviewArtifactBaseDomain(productionDomain)).toBe(
      productionDomain,
    )
    expect(parsePreviewArtifactBaseDomain(" 3.34.33.24.NIP.IO ")).toBe(
      productionDomain,
    )
    expect(parsePreviewArtifactBaseDomain(undefined)).toBeNull()
    expect(parsePreviewArtifactBaseDomain(" ")).toBeNull()
    expect(parsePreviewArtifactBaseDomain(`${"a".repeat(63)}.io`)).toBe(
      `${"a".repeat(63)}.io`,
    )
  })
  it.each([
    "https://3.34.33.24.nip.io",
    "3.34.33.24.nip.io:443",
    "3.34.33.24.nip.io/path",
    "nip.io?x",
    "nip.io#x",
    "localhost",
    "app.localhost",
    "127.0.0.1",
    "[::1]",
    "127.1",
    "0x7f.1",
    "single",
    "foo..io",
    ".nip.io",
    "nip.io.",
    "-foo.io",
    "foo-.io",
    "foo_bar.io",
    "*.nip.io",
    `${"a".repeat(64)}.io`,
    `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}`,
  ])("rejects invalid domain %s", (value) => {
    expect(() => parsePreviewArtifactBaseDomain(value)).toThrow(
      /WXT_PREVIEW_ARTIFACT_BASE_DOMAIN/,
    )
  })
})

describe("production artifact URLs", () => {
  it.each([
    `https://${productionHost}/`,
    `https://${productionHost}/assets/index.html`,
    `https://${productionHost.toUpperCase()}/`,
  ])("accepts exact artifact hostname %s", (value) => {
    expect(isTrustedPreviewArtifactUrl(value, productionDomain)).toBe(true)
  })
  it.each([
    `https://evil.${productionDomain}/`,
    `https://foo.${productionHost}/`,
    `https://${productionDomain}/`,
    `https://${artifactId}.evil.com/`,
    `https://${artifactId}.${productionDomain}.evil.com/`,
    `http://${productionHost}/`,
    `https://${productionHost}:8443/`,
    `https://${productionHost}:443/`,
    `https://artifact-uuid.${productionDomain}/`,
    `https://${productionHost}/?x=1`,
    `https://${productionHost}/#x`,
    `https://${productionHost}/?`,
    `https://${productionHost}/#`,
    `https://user:pass@${productionHost}/`,
    `https://@${productionHost}/`,
    `https://${productionHost}/\n`,
    `https://${productionHost}\\path`,
    `https://${productionHost}./`,
  ])("rejects unsafe artifact URL %s", (value) => {
    expect(isTrustedPreviewArtifactUrl(value, productionDomain)).toBe(false)
  })
  it("requires valid production configuration", () => {
    const url = `https://${productionHost}/`
    for (const domain of [undefined, null, "", "*.nip.io", "https://nip.io"])
      expect(isTrustedPreviewArtifactUrl(url, domain)).toBe(false)
    expect(
      isTrustedPreviewArtifactUrl(
        "http://127.0.0.1:1234/path",
        productionDomain,
      ),
    ).toBe(true)
  })
})

describe("manifest frame sources", () => {
  it("keeps localhost-only sources when production is absent", () => {
    expect(getPreviewFrameSrc()).toBe("frame-src 'self' http://127.0.0.1:*;")
  })
  it("adds only the configured production wildcard", () => {
    expect(getPreviewFrameSrc(productionDomain)).toBe(
      "frame-src 'self' http://127.0.0.1:* https://*.3.34.33.24.nip.io;",
    )
  })
  it("rejects CSP injection", () => {
    expect(() => getPreviewFrameSrc("nip.io; script-src *")).toThrow()
  })
})
