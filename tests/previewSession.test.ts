import { describe, expect, it } from "vitest"

import { PreviewSessionIssuer } from "../services/preview-api/previewSession"

const SECRET = "session-signing-secret-with-at-least-32-bytes"

describe("PreviewSessionIssuer", () => {
  it("issues a token that verifies back to the same subject", async () => {
    const issuer = new PreviewSessionIssuer(SECRET)

    const issued = await issuer.issue("github:42")

    expect(await issuer.verify(issued.token)).toBe("github:42")
  })

  it("rejects a token once it has expired", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z")
    const issuer = new PreviewSessionIssuer(SECRET, {
      ttlMs: 60_000,
      now: () => new Date(now),
    })

    const issued = await issuer.issue("github:42")
    expect(await issuer.verify(issued.token)).toBe("github:42")

    now += 61_000
    expect(await issuer.verify(issued.token)).toBeNull()
  })

  it("rejects a token signed with a different secret", async () => {
    const issuerA = new PreviewSessionIssuer(SECRET)
    const issuerB = new PreviewSessionIssuer(
      "a-completely-different-secret-32bytes!!",
    )

    const issued = await issuerA.issue("github:42")

    expect(await issuerB.verify(issued.token)).toBeNull()
  })

  it("rejects a token whose subject was tampered with after signing", async () => {
    const issuer = new PreviewSessionIssuer(SECRET)
    const issued = await issuer.issue("github:42")
    const [, expiresPart, signaturePart] = issued.token.split(".")

    const tampered = [
      Buffer.from("github:9999999").toString("base64url"),
      expiresPart,
      signaturePart,
    ].join(".")

    expect(await issuer.verify(tampered)).toBeNull()
  })

  it("rejects malformed tokens without throwing", async () => {
    const issuer = new PreviewSessionIssuer(SECRET)

    await expect(issuer.verify("not-a-real-token")).resolves.toBeNull()
    await expect(issuer.verify("a.b")).resolves.toBeNull()
    await expect(issuer.verify("a.b.c.d")).resolves.toBeNull()
    await expect(issuer.verify("a.not-a-number.c")).resolves.toBeNull()
  })

  it("requires a signing secret of at least 32 bytes", () => {
    expect(() => new PreviewSessionIssuer("too-short")).toThrow("32 bytes")
  })
})
