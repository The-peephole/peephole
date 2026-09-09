import type { IncomingMessage, IncomingHttpHeaders } from "node:http"
import { describe, expect, it } from "vitest"

import { resolveRequesterIp } from "../services/preview-api/requesterIp"

describe("resolveRequesterIp", () => {
  it("uses the socket address for a direct public IPv4 request", () => {
    expect(resolveRequesterIp(fakeRequest("203.0.113.5"))).toBe("203.0.113.5")
  })

  it("ignores spoofed X-Forwarded-For from a non-loopback peer", () => {
    expect(
      resolveRequesterIp(
        fakeRequest("203.0.113.5", { "x-forwarded-for": "198.51.100.9" }),
      ),
    ).toBe("203.0.113.5")
  })

  it("uses a valid forwarded client behind an IPv4 loopback proxy", () => {
    expect(
      resolveRequesterIp(
        fakeRequest("127.0.0.1", { "x-forwarded-for": "198.51.100.9" }),
      ),
    ).toBe("198.51.100.9")
  })

  it("uses a forwarded client behind an IPv6 loopback proxy", () => {
    expect(
      resolveRequesterIp(
        fakeRequest("::1", { "x-forwarded-for": "2001:db8::9" }),
      ),
    ).toBe("2001:db8::9")
  })

  it("canonicalizes an IPv4-mapped loopback peer before trusting it", () => {
    expect(
      resolveRequesterIp(
        fakeRequest("::ffff:127.0.0.1", {
          "x-forwarded-for": "198.51.100.9",
        }),
      ),
    ).toBe("198.51.100.9")
  })

  it.each([
    "not-an-ip",
    "198.51.100.9,,203.0.113.7",
    " ",
    "198.51.100.9,".repeat(200),
  ])("falls back to the socket IP for malformed XFF %j", (value) => {
    expect(
      resolveRequesterIp(
        fakeRequest("127.0.0.1", { "x-forwarded-for": value }),
      ),
    ).toBe("127.0.0.1")
  })

  it("canonicalizes a direct IPv6 client", () => {
    expect(resolveRequesterIp(fakeRequest("2001:0db8:0:0:0:0:0:1"))).toBe(
      "2001:db8::1",
    )
  })

  it("walks a forwarded chain from the trusted proxy side", () => {
    expect(
      resolveRequesterIp(
        fakeRequest("127.0.0.1", {
          "x-forwarded-for": "198.51.100.9, 127.0.0.2",
        }),
      ),
    ).toBe("198.51.100.9")

    // The nearest non-loopback proxy is not trusted, so a claimed address to
    // its left cannot control the quota identity.
    expect(
      resolveRequesterIp(
        fakeRequest("127.0.0.1", {
          "x-forwarded-for": "192.0.2.1, 198.51.100.20",
        }),
      ),
    ).toBe("198.51.100.20")
  })

  it("supports Node's array header representation", () => {
    expect(
      resolveRequesterIp(
        fakeRequest("::1", {
          "x-forwarded-for": ["198.51.100.9", "127.0.0.2"],
        }),
      ),
    ).toBe("198.51.100.9")
  })

  it("canonicalizes mapped clients into the same bounded quota key", () => {
    const native = resolveRequesterIp(
      fakeRequest("127.0.0.1", { "x-forwarded-for": "203.0.113.7" }),
    )
    const mapped = resolveRequesterIp(
      fakeRequest("127.0.0.1", {
        "x-forwarded-for": "::ffff:203.0.113.7",
      }),
    )

    expect(mapped).toBe(native)
    expect(mapped.length).toBeLessThanOrEqual(64)
    expect(mapped).not.toContain(",")
  })
})

function fakeRequest(
  remoteAddress: string | undefined,
  headers: IncomingHttpHeaders = {},
): IncomingMessage {
  return {
    headers,
    socket: { remoteAddress },
  } as unknown as IncomingMessage
}
