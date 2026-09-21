import { randomUUID } from "node:crypto"
import { createServer, request, type Server } from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { BoundedBackendProxy } from "../services/fullstack-routing/backendProxy"
import type {
  FullStackRoutingRecord,
  FullStackRoutingStore,
} from "../services/fullstack-routing/ports"
import { LiveBackendRuntimeRegistry } from "../services/backend-runtime-worker/liveRuntimeRegistry"
import { ProductionArtifactHost } from "../services/production/artifactHost"
import type { ProductionArtifactStore } from "../services/preview-api/postgres/productionArtifactStore"

const baseDomain = "peepholeusercontent.dev"
const future = () => new Date("2026-09-22T00:00:00.000Z")
const now = () => new Date("2026-09-21T00:00:00.000Z")

class ArtifactStore implements ProductionArtifactStore {
  readonly rows = new Map<string, Date>()
  async upsertMaxExpiry(id: string, expiresAt: Date) {
    this.rows.set(id, expiresAt)
  }
  async get(id: string) {
    const expiresAt = this.rows.get(id)
    return expiresAt ? { expiresAt } : null
  }
  async listExpired() {
    return []
  }
  async deleteIfStillExpired() {
    return false
  }
}

class RoutingStore implements FullStackRoutingStore {
  readonly rows = new Map<string, FullStackRoutingRecord>()
  async get(id: string) {
    return this.rows.get(id) ?? null
  }
}

async function backend(
  identity: string,
): Promise<{ server: Server; port: number; connectionCount: () => number }> {
  let connections = 0
  const server = createServer((req, res) => {
    if (req.url === "/api/identity") {
      res.setHeader("content-type", "text/plain")
      res.end(identity)
      return
    }
    if (req.url?.startsWith("/api/echo")) {
      res.setHeader("content-type", "application/json")
      res.setHeader("set-cookie", "secret=yes")
      res.setHeader("access-control-allow-origin", "*")
      res.setHeader("content-security-policy", "default-src *")
      res.setHeader("x-frame-options", "ALLOWALL")
      res.setHeader("server", "secret-server")
      res.setHeader("x-powered-by", "secret-framework")
      res.end(JSON.stringify({ url: req.url, headers: req.headers }))
      return
    }
    if (req.url === "/api/redirect") {
      res.writeHead(302, { location: "https://example.com/" }).end()
      return
    }
    if (req.url === "/api/large-declared") {
      res.writeHead(200, { "content-length": 256 * 1024 + 1 })
      res.end("x")
      return
    }
    if (req.url === "/api/large-streamed") {
      res.writeHead(200)
      res.write(Buffer.alloc(256 * 1024 + 1, "x"))
      res.end()
      return
    }
    if (req.url === "/api/under-limit") {
      res.writeHead(201, { "content-type": "text/plain" })
      res.end("small")
      return
    }
    if (req.url === "/api/slow") {
      setTimeout(() => res.end("late"), 150)
      return
    }
    res.writeHead(404).end("backend not found")
  })
  server.on("connection", () => {
    connections += 1
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no address")
  return { server, port: address.port, connectionCount: () => connections }
}

function getResponse(
  port: number,
  requestTarget: string,
  options: {
    host: string
    method?: string
    headers?: Record<string, string>
    body?: string
  },
) {
  return new Promise<{
    status: number
    headers: import("node:http").IncomingHttpHeaders
    body: string
  }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: requestTarget,
        method: options.method ?? "GET",
        headers: { ...options.headers, host: options.host },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        )
      },
    )
    req.on("error", reject)
    req.end(options.body)
  })
}

describe("ProductionArtifactHost full-stack routing", () => {
  let storageDir: string
  let artifactStore: ArtifactStore
  let routingStore: RoutingStore
  let registry: LiveBackendRuntimeRegistry
  let host: ProductionArtifactHost
  let hostPort: number
  let backendA: Awaited<ReturnType<typeof backend>>
  let backendB: Awaited<ReturnType<typeof backend>>
  let artifactId: string
  let fullstackA: string
  let fullstackB: string

  beforeEach(async () => {
    storageDir = await mkdtemp(path.join(os.tmpdir(), "peephole-fullstack-"))
    artifactId = `artifact-${randomUUID()}`
    fullstackA = `fullstack-${randomUUID()}`
    fullstackB = `fullstack-${randomUUID()}`
    await mkdir(path.join(storageDir, artifactId), { recursive: true })
    await writeFile(path.join(storageDir, artifactId, "index.html"), "frontend")
    artifactStore = new ArtifactStore()
    artifactStore.rows.set(artifactId, future())
    routingStore = new RoutingStore()
    routingStore.rows.set(fullstackA, {
      id: fullstackA,
      status: "ready",
      artifactId,
      backendRuntimeId: "runtime-a",
      expiresAt: future(),
    })
    routingStore.rows.set(fullstackB, {
      id: fullstackB,
      status: "ready",
      artifactId,
      backendRuntimeId: "runtime-b",
      expiresAt: future(),
    })
    backendA = await backend("A")
    backendB = await backend("B")
    registry = new LiveBackendRuntimeRegistry()
    registry.register("runtime-a", { host: "127.0.0.1", port: backendA.port })
    registry.register("runtime-b", { host: "127.0.0.1", port: backendB.port })
    host = new ProductionArtifactHost({
      storageDir,
      store: artifactStore,
      port: 0,
      baseDomain,
      now,
      fullStackRouting: {
        store: routingStore,
        liveRuntimeResolver: registry,
        backendProxy: new BoundedBackendProxy({
          trustedAppOrigin: "https://app.peephole.dev",
          timeoutMs: 40,
        }),
      },
    })
    hostPort = (await host.listen()).port
  })

  afterEach(async () => {
    await host.close()
    await Promise.all(
      [backendA?.server, backendB?.server]
        .filter(Boolean)
        .map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
    )
    await rm(storageDir, { recursive: true, force: true })
  })

  it("isolates two runtimes behind unique origins even when they share artifact bytes", async () => {
    expect(fullstackA).not.toBe(fullstackB)
    expect(
      (
        await getResponse(hostPort, "/api/identity", {
          host: `${fullstackA}.${baseDomain}`,
        })
      ).body,
    ).toBe("A")
    expect(
      (
        await getResponse(hostPort, "/api/identity", {
          host: `${fullstackB}.${baseDomain}`,
        })
      ).body,
    ).toBe("B")
    registry.unregister("runtime-a")
    expect(
      await getResponse(hostPort, "/api/identity", {
        host: `${fullstackA}.${baseDomain}`,
      }),
    ).toMatchObject({ status: 502, body: "Backend unavailable." })
    expect(
      (
        await getResponse(hostPort, "/api/identity", {
          host: `${fullstackB}.${baseDomain}`,
        })
      ).body,
    ).toBe("B")
  })

  it("opens a fresh upstream connection for every request", async () => {
    const domain = `${fullstackA}.${baseDomain}`
    await getResponse(hostPort, "/api/identity", { host: domain })
    await getResponse(hostPort, "/api/identity", { host: domain })
    expect(backendA.connectionCount()).toBe(2)
  })

  it("applies exact API selection before URL normalization", async () => {
    const domain = `${fullstackA}.${baseDomain}`
    for (const target of ["/api", "/api/", "/api/hello", "/api/hello?x=1"]) {
      const response = await getResponse(hostPort, target, { host: domain })
      expect(response).toMatchObject({ status: 404, body: "backend not found" })
    }
    for (const target of ["/API/hello", "/apiary"]) {
      const response = await getResponse(hostPort, target, {
        host: domain,
        headers: { accept: "text/html" },
      })
      expect(response).toMatchObject({ status: 200, body: "frontend" })
    }
    const connectionsBeforeInvalidTargets = backendA.connectionCount()
    for (const target of [
      "//api/hello",
      "/api/../secret",
      "/api/./hello",
      "/api/%2e%2e/secret",
      "/api/%2Fsecret",
      "/api/%2fsecret",
      "/api/%5Csecret",
      "/api/%5csecret",
      "/api\\hello",
      "/api/%ZZ",
    ]) {
      expect(
        (await getResponse(hostPort, target, { host: domain })).status,
      ).toBe(400)
    }
    expect(backendA.connectionCount()).toBe(connectionsBeforeInvalidTargets)
  })

  it("serves shared static bytes with full-stack CSP while artifact /api remains static", async () => {
    const full = await getResponse(hostPort, "/apiary", {
      host: `${fullstackA}.${baseDomain}`,
      headers: { accept: "text/html" },
    })
    expect(full.body).toBe("frontend")
    expect(full.headers["content-security-policy"]).toContain(
      "connect-src 'self'",
    )

    const artifact = await getResponse(hostPort, "/api/identity", {
      host: `${artifactId}.${baseDomain}`,
      headers: { accept: "text/html" },
    })
    expect(artifact.body).toBe("frontend")
    expect(artifact.headers["content-security-policy"]).toContain(
      "connect-src 'none'",
    )
  })

  it("forwards the original query and only allowlisted request headers with a generated Host", async () => {
    const response = await getResponse(
      hostPort,
      "/api/echo?host=1.1.1.1&url=http://169.254.169.254/",
      {
        host: `${fullstackA}.${baseDomain}`,
        headers: {
          accept: "application/json",
          "accept-language": "ko",
          authorization: "Bearer secret",
          cookie: "secret=yes",
          "x-backend-host": "10.0.0.1",
          "x-forwarded-host": "evil.example",
          origin: "https://evil.example",
          referer: "https://evil.example/",
        },
      },
    )
    expect(response.status).toBe(200)
    const received = JSON.parse(response.body)
    expect(received.url).toBe(
      "/api/echo?host=1.1.1.1&url=http://169.254.169.254/",
    )
    expect(received.headers).toMatchObject({
      accept: "application/json",
      "accept-language": "ko",
      host: `localhost:${backendA.port}`,
    })
    for (const forbidden of [
      "authorization",
      "cookie",
      "x-backend-host",
      "x-forwarded-host",
      "origin",
      "referer",
    ]) {
      expect(received.headers).not.toHaveProperty(forbidden)
    }
  })

  it("drops unsafe response headers and replaces redirects with 502", async () => {
    const echo = await getResponse(hostPort, "/api/echo", {
      host: `${fullstackA}.${baseDomain}`,
    })
    for (const forbidden of [
      "set-cookie",
      "access-control-allow-origin",
      "location",
      "server",
      "x-powered-by",
      "x-frame-options",
    ]) {
      expect(echo.headers[forbidden]).toBeUndefined()
    }
    expect(echo.headers["content-security-policy"]).toContain(
      "connect-src 'self'",
    )

    const redirect = await getResponse(hostPort, "/api/redirect", {
      host: `${fullstackA}.${baseDomain}`,
    })
    expect(redirect.status).toBe(502)
    expect(redirect.headers.location).toBeUndefined()
  })

  it.each(["/api/large-declared", "/api/large-streamed"])(
    "rejects oversized backend response %s",
    async (target) => {
      const response = await getResponse(hostPort, target, {
        host: `${fullstackA}.${baseDomain}`,
      })
      expect(response).toMatchObject({
        status: 502,
        body: "Backend unavailable.",
      })
    },
  )

  it("preserves an under-limit status/body and times out a slow response", async () => {
    expect(
      await getResponse(hostPort, "/api/under-limit", {
        host: `${fullstackA}.${baseDomain}`,
      }),
    ).toMatchObject({ status: 201, body: "small" })
    expect(
      await getResponse(hostPort, "/api/slow", {
        host: `${fullstackA}.${baseDomain}`,
      }),
    ).toMatchObject({ status: 504, body: "Backend timed out." })
    const head = await getResponse(hostPort, "/api/identity", {
      host: `${fullstackA}.${baseDomain}`,
      method: "HEAD",
    })
    expect(head.status).toBe(200)
    expect(head.body).toBe("")
  })

  it("fails closed on connection refusal without leaking the dial target", async () => {
    registry.register("runtime-dead", { host: "127.0.0.1", port: 1 })
    routingStore.rows.set(fullstackA, {
      ...routingStore.rows.get(fullstackA)!,
      backendRuntimeId: "runtime-dead",
    })
    const response = await getResponse(hostPort, "/api/identity", {
      host: `${fullstackA}.${baseDomain}`,
    })
    expect(response.status).toBe(502)
    expect(response.body).not.toMatch(/127\.0\.0\.1|\b1\b/)
  })

  it("rejects bodies, transfer encoding, upgrades, other methods, absolute-form, and bad Host before dialing", async () => {
    const domain = `${fullstackA}.${baseDomain}`
    expect(
      (
        await getResponse(hostPort, "/api/identity", {
          host: domain,
          method: "POST",
        })
      ).status,
    ).toBe(405)
    expect(
      (
        await getResponse(hostPort, "/api/identity", {
          host: domain,
          headers: { "content-length": "1" },
          body: "x",
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await getResponse(hostPort, "/api/identity", {
          host: domain,
          headers: { "transfer-encoding": "chunked" },
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await getResponse(hostPort, "http://example.com/api/identity", {
          host: domain,
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await getResponse(hostPort, "/api/identity", {
          host: `extra.${domain}`,
        })
      ).status,
    ).toBe(404)
  })

  it("returns 404/410 for unauthorized routing or artifact metadata", async () => {
    routingStore.rows.set(fullstackA, {
      ...routingStore.rows.get(fullstackA)!,
      status: "awaiting_activation",
    })
    expect(
      (
        await getResponse(hostPort, "/", {
          host: `${fullstackA}.${baseDomain}`,
        })
      ).status,
    ).toBe(404)
    routingStore.rows.set(fullstackA, {
      ...routingStore.rows.get(fullstackA)!,
      status: "ready",
      expiresAt: now(),
    })
    expect(
      (
        await getResponse(hostPort, "/", {
          host: `${fullstackA}.${baseDomain}`,
        })
      ).status,
    ).toBe(410)
  })
})
