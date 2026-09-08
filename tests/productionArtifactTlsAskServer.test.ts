import { createServer, request } from "node:http"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ProductionArtifactTlsAskServer } from "../services/production/artifactTlsAskServer"
import type { ProductionArtifactMetadata } from "../services/preview-api/postgres/productionArtifactStore"

const artifactId = "artifact-9f3c1a2b-4d5e-4f67-8a90-123456789abc"
const baseDomain = "3.34.44.114.nip.io"
const domain = `${artifactId}.${baseDomain}`
const check = (value: string) => `/check?domain=${encodeURIComponent(value)}`

function getResponse(port: number, path: string, method = "GET") {
  return new Promise<{
    status: number
    headers: import("node:http").IncomingHttpHeaders
    body: string
  }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        )
      },
    )
    req.on("error", reject)
    req.end()
  })
}

describe("ProductionArtifactTlsAskServer", () => {
  let server: ProductionArtifactTlsAskServer
  let port: number
  let now: number
  const get =
    vi.fn<(id: string) => Promise<ProductionArtifactMetadata | null>>()

  beforeEach(async () => {
    now = Date.parse("2026-09-08T00:00:00Z")
    get.mockReset().mockResolvedValue({ expiresAt: new Date(now + 1) })
    server = new ProductionArtifactTlsAskServer({
      store: { get },
      port: 0,
      baseDomain,
      now: () => new Date(now),
    })
    const address = await server.listen()
    expect(address.host).toBe("127.0.0.1")
    port = address.port
  })

  afterEach(async () => {
    await server.close()
  })

  it.each([domain, domain.toUpperCase()])(
    "allows live metadata for %s with security headers",
    async (hostname) => {
      const response = await getResponse(port, check(hostname))
      expect(response.status).toBe(200)
      expect(response.body).toBe("Allowed.")
      expect(response.headers["cache-control"]).toBe("no-store")
      expect(response.headers["x-content-type-options"]).toBe("nosniff")
      expect(response.headers["access-control-allow-origin"]).toBeUndefined()
      expect(get).toHaveBeenCalledExactlyOnceWith(artifactId)
    },
  )

  it.each([null, -1, 0, NaN])(
    "denies missing/expired/invalid metadata (%s)",
    async (offset) => {
      get.mockResolvedValue(
        offset === null ? null : { expiresAt: new Date(now + offset) },
      )
      const response = await getResponse(port, check(domain))
      expect(response.status).toBe(403)
      expect(response.body).toBe("Forbidden.")
      expect(response.headers["cache-control"]).toBe("no-store")
      expect(response.headers["x-content-type-options"]).toBe("nosniff")
    },
  )

  it("fails closed on DB errors without exposing details", async () => {
    get.mockRejectedValue(new Error("secret DB credentials"))
    const response = await getResponse(port, check(domain))
    expect(response.status).toBe(403)
    expect(response.body).toBe("Forbidden.")
  })

  it("checks expiry after lookup and rechecks each request without caching", async () => {
    expect((await getResponse(port, check(domain))).status).toBe(200)
    get.mockImplementation(async () => {
      const expiresAt = new Date(now + 1)
      now += 1
      return { expiresAt }
    })
    expect((await getResponse(port, check(domain))).status).toBe(403)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it.each([
    `${artifactId}.example.com`,
    "peephole.dev",
    "api.peephole.dev",
    `artifact-invalid.${baseDomain}`,
    `extra.${domain}`,
    `${domain}:443`,
    `${domain}:8790`,
    `${domain}.`,
    ` ${domain}`,
    `${domain} `,
    `${domain}\n`,
    `https://${domain}`,
    `${domain}/`,
    "",
    "example.com",
    `*.${baseDomain}`,
    `${artifactId}\n.${baseDomain}`,
    `${domain}@example.com`,
    `${artifactId}.3.34.44.114.nıp.io`,
    `${"a".repeat(64)}.${domain}`,
  ])(
    "denies malformed or foreign hostname %j before DB lookup",
    async (hostname) => {
      expect((await getResponse(port, check(hostname))).status).toBe(403)
      expect(get).not.toHaveBeenCalled()
    },
  )

  it.each([
    "/check",
    "/check?domain=",
    `/check?domain=${domain}&domain=${domain}`,
    `/check?domain=${domain}&%64omain=`,
    "/check?domain=%ZZ",
    "/check?domain=%00",
  ])("rejects invalid domain query %s", async (path) => {
    expect((await getResponse(port, path)).status).toBe(403)
    expect(get).not.toHaveBeenCalled()
  })

  it.each([
    "/",
    `/other?domain=${domain}`,
    `/x/../check?domain=${domain}`,
    `http://localhost/check?domain=${domain}`,
    `/check?domain=${domain}#fragment`,
  ])("rejects unsupported raw path %s", async (path) => {
    expect((await getResponse(port, path)).status).toBe(404)
    expect(get).not.toHaveBeenCalled()
  })

  it.each(["POST", "PUT", "DELETE", "HEAD", "OPTIONS"])(
    "rejects %s",
    async (method) => {
      const response = await getResponse(port, check(domain), method)
      expect(response.status).toBe(405)
      expect(response.headers.allow).toBe("GET")
      expect(response.headers["cache-control"]).toBe("no-store")
      expect(get).not.toHaveBeenCalled()
    },
  )

  it("uses configured port, listens idempotently and closes cleanly", async () => {
    expect(await server.listen()).toEqual({ host: "127.0.0.1", port })
    await server.close()
    await server.close()
    await expect(getResponse(port, check(domain))).rejects.toThrow()
    server = new ProductionArtifactTlsAskServer({
      store: { get },
      port,
      baseDomain,
    })
    expect(await server.listen()).toEqual({ host: "127.0.0.1", port })
  })

  it("rejects startup on a port conflict", async () => {
    const conflicting = new ProductionArtifactTlsAskServer({
      store: { get },
      port,
    })
    try {
      await expect(conflicting.listen()).rejects.toMatchObject({
        code: "EADDRINUSE",
      })
    } finally {
      await conflicting.close()
    }
  })

  it("actually binds only IPv4 loopback", async () => {
    // Another loopback address can bind the same port, proving this is
    // not a wildcard 0.0.0.0 listener.
    const other = createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        other.once("error", reject)
        other.listen(port, "127.0.0.2", resolve)
      })
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()))
    }
  })
})
