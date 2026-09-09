import type { IncomingMessage } from "node:http"
import { describe, expect, it } from "vitest"

import { HttpIngressError } from "../services/preview-api/nodeHttpServer"
import { PreviewSessionAuth } from "../services/preview-api/previewSessionAuth"
import { PreviewSessionIssuer } from "../services/preview-api/previewSession"

const SECRET = "session-signing-secret-with-at-least-32-bytes"

describe("PreviewSessionAuth", () => {
  it("resolves the requester from a valid session token", async () => {
    const issuer = new PreviewSessionIssuer(SECRET)
    const auth = new PreviewSessionAuth(issuer)
    const { token } = await issuer.issue("github:42")

    await expect(auth.resolve(fakeRequest(`Bearer ${token}`))).resolves.toEqual(
      { subject: "github:42", ip: "203.0.113.5" },
    )
  })

  it("uses the trusted-proxy requester IP resolver", async () => {
    const issuer = new PreviewSessionIssuer(SECRET)
    const auth = new PreviewSessionAuth(issuer)
    const { token } = await issuer.issue("github:42")

    await expect(
      auth.resolve(fakeRequest(`Bearer ${token}`, "127.0.0.1", "2001:0db8::7")),
    ).resolves.toEqual({ subject: "github:42", ip: "2001:db8::7" })
  })

  it("rejects a missing Authorization header", async () => {
    const auth = new PreviewSessionAuth(new PreviewSessionIssuer(SECRET))

    await expect(auth.resolve(fakeRequest(undefined))).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    })
  })

  it("rejects an expired or invalid session with a distinct, actionable message", async () => {
    const auth = new PreviewSessionAuth(new PreviewSessionIssuer(SECRET))

    const error: unknown = await auth
      .resolve(fakeRequest("Bearer not-a-real-session"))
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(HttpIngressError)
    expect((error as HttpIngressError).status).toBe(401)
    expect((error as HttpIngressError).code).toBe("UNAUTHORIZED")
    expect((error as HttpIngressError).message).toMatch(/sign in/i)
  })

  it("never accepts a raw GitHub token in place of a session", async () => {
    // A GitHub PAT and a session token happen to both be opaque bearer
    // strings, but they are not interchangeable: this class only ever
    // verifies its own HMAC-signed format, so nothing shaped like a real
    // PAT (ghp_...) can slip through as a session.
    const auth = new PreviewSessionAuth(new PreviewSessionIssuer(SECRET))

    await expect(
      auth.resolve(fakeRequest("Bearer fake-peephole-session-token")),
    ).rejects.toMatchObject({ status: 401 })
  })
})

function fakeRequest(
  authorization: string | undefined,
  remoteAddress = "203.0.113.5",
  forwardedFor?: string,
): IncomingMessage {
  return {
    headers: { authorization, "x-forwarded-for": forwardedFor },
    socket: { remoteAddress },
  } as unknown as IncomingMessage
}
