import { afterEach, describe, expect, it } from "vitest"

import { PreviewControlPlane } from "../services/preview-api/controlPlane"
import { createPreviewHttpHandler } from "../services/preview-api/http"
import {
  FixedWindowPreviewQuota,
  HmacPreviewArtifactSigner,
  InMemoryPreviewArtifactCache,
  InMemoryPreviewJobStore,
  InMemoryPreviewQueue,
} from "../services/preview-api/inMemoryAdapters"
import {
  HttpIngressError,
  NodePreviewApiServer,
} from "../services/preview-api/nodeHttpServer"
import type { BuildPlan, PreviewRequester } from "../types/preview"

const repository = {
  repositoryId: 1,
  owner: "acme",
  name: "web",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
}

const plan: BuildPlan = {
  contractVersion: "static-v1",
  repository,
  sourceRoot: ".",
  packageManager: "npm",
  installCommand: "npm ci",
  buildCommand: "npm run build",
  outputDirectory: "dist",
}

const requester: PreviewRequester = {
  subject: "anonymous-test-user",
  ip: "127.0.0.1",
}

describe("NodePreviewApiServer", () => {
  const servers: NodePreviewApiServer[] = []

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()))
    servers.length = 0
  })

  it("serves the create, status, and cancel contract over real HTTP", async () => {
    const server = createTestServer()
    servers.push(server)
    const baseUrl = await listen(server)

    const create = await fetch(`${baseUrl}/v1/preview-jobs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "request-0000000001",
      },
      body: JSON.stringify({ repository, contractVersion: "static-v1" }),
    })
    const created = (await create.json()) as { job: { id: string } }

    expect(create.status).toBe(202)
    expect(create.headers.get("cache-control")).toBe("no-store")
    expect(create.headers.get("x-content-type-options")).toBe("nosniff")

    const status = await fetch(`${baseUrl}/v1/preview-jobs/${created.job.id}`)
    expect(status.status).toBe(200)
    await expect(status.json()).resolves.toMatchObject({ status: "queued" })

    const cancel = await fetch(`${baseUrl}/v1/preview-jobs/${created.job.id}`, {
      method: "DELETE",
    })
    expect(cancel.status).toBe(202)
    await expect(cancel.json()).resolves.toMatchObject({ status: "cancelled" })
  })

  it("reports liveness and dependency readiness separately", async () => {
    const server = createTestServer({ isReady: () => false })
    servers.push(server)
    const baseUrl = await listen(server)

    const health = await fetch(`${baseUrl}/healthz`)
    const readiness = await fetch(`${baseUrl}/readyz`)

    expect(health.status).toBe(200)
    await expect(health.json()).resolves.toEqual({ ok: true })
    expect(readiness.status).toBe(503)
    await expect(readiness.json()).resolves.toEqual({ ready: false })
  })

  it("rejects invalid content types, JSON, oversized bodies, and methods", async () => {
    const server = createTestServer({ maxBodyBytes: 32 })
    servers.push(server)
    const baseUrl = await listen(server)

    const wrongType = await fetch(`${baseUrl}/v1/preview-jobs`, {
      method: "POST",
      body: "{}",
    })
    const malformed = await fetch(`${baseUrl}/v1/preview-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    })
    const tooLarge = await fetch(`${baseUrl}/v1/preview-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(64) }),
    })
    const method = await fetch(`${baseUrl}/v1/preview-jobs`, {
      method: "PUT",
    })

    expect(wrongType.status).toBe(415)
    expect(malformed.status).toBe(400)
    expect(tooLarge.status).toBe(413)
    expect(method.status).toBe(405)
    expect(method.headers.get("allow")).toBe("GET, POST, DELETE")
  })

  it("404s the login route when issueSession is not configured, and serves it when it is", async () => {
    const withoutLogin = createTestServer()
    servers.push(withoutLogin)
    const withoutLoginUrl = await listen(withoutLogin)

    const missing = await fetch(`${withoutLoginUrl}/v1/auth/session`, {
      method: "POST",
    })
    expect(missing.status).toBe(404)

    const withLogin = createTestServer({
      issueSession: async () => ({
        token: "session-token",
        expiresAt: "2026-01-01T00:00:00.000Z",
      }),
    })
    servers.push(withLogin)
    const withLoginUrl = await listen(withLogin)

    const issued = await fetch(`${withLoginUrl}/v1/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "code", state: "state" }),
    })
    expect(issued.status).toBe(200)
    await expect(issued.json()).resolves.toEqual({
      token: "session-token",
      expiresAt: "2026-01-01T00:00:00.000Z",
    })
  })

  it("surfaces a login failure with its own status and code, not a generic 500", async () => {
    const server = createTestServer({
      issueSession: async () => {
        throw new HttpIngressError(
          401,
          "GitHub authorization is invalid.",
          "UNAUTHORIZED",
        )
      },
    })
    servers.push(server)
    const baseUrl = await listen(server)

    const response = await fetch(`${baseUrl}/v1/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(401)
    expect(body.error.code).toBe("UNAUTHORIZED")
  })

  it("redirects the GitHub App start and callback endpoints without caching", async () => {
    const server = createTestServer({
      beginGitHubAuth: async () => "https://github.com/login/oauth/authorize",
      completeGitHubAuth: async () =>
        "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/github#code=test",
    })
    servers.push(server)
    const baseUrl = await listen(server)

    const start = await fetch(`${baseUrl}/v1/auth/github/start`, {
      redirect: "manual",
    })
    const callback = await fetch(`${baseUrl}/v1/auth/github/callback`, {
      redirect: "manual",
    })

    expect(start.status).toBe(302)
    expect(start.headers.get("location")).toBe(
      "https://github.com/login/oauth/authorize",
    )
    expect(callback.status).toBe(302)
    expect(callback.headers.get("location")).toContain(
      ".chromiumapp.org/github",
    )
    expect(callback.headers.get("cache-control")).toBe("no-store")
    expect(callback.headers.get("referrer-policy")).toBe("no-referrer")
  })

  it("does not expose requester resolver failures", async () => {
    const server = createTestServer({
      resolveRequester: () => {
        throw new Error("database password should stay private")
      },
    })
    servers.push(server)
    const baseUrl = await listen(server)

    const response = await fetch(`${baseUrl}/v1/preview-jobs/job-00000001`)
    const body = await response.text()

    expect(response.status).toBe(500)
    expect(body).toContain("INTERNAL_ERROR")
    expect(body).not.toContain("database password")
  })
})

function createTestServer(
  options: {
    isReady?: () => boolean
    maxBodyBytes?: number
    resolveRequester?: () => PreviewRequester
    beginGitHubAuth?: () => Promise<string>
    completeGitHubAuth?: () => Promise<string>
    issueSession?: (
      request: unknown,
      body: unknown,
    ) => Promise<{ token: string; expiresAt: string }>
  } = {},
): NodePreviewApiServer {
  const controlPlane = new PreviewControlPlane(
    { resolve: async () => plan },
    new InMemoryPreviewJobStore(),
    new InMemoryPreviewQueue(),
    new InMemoryPreviewArtifactCache(),
    new HmacPreviewArtifactSigner(
      "peephole.run",
      "test-signing-secret-with-at-least-32-bytes",
    ),
    new FixedWindowPreviewQuota(),
    {
      runnerVersion: "runner-v1",
      createId: () => "job-00000001",
    },
  )

  return new NodePreviewApiServer({
    handlePreviewRequest: createPreviewHttpHandler(controlPlane),
    resolveRequester: options.resolveRequester ?? (() => requester),
    beginGitHubAuth: options.beginGitHubAuth,
    completeGitHubAuth: options.completeGitHubAuth,
    issueSession: options.issueSession,
    isReady: options.isReady,
    maxBodyBytes: options.maxBodyBytes,
  })
}

async function listen(server: NodePreviewApiServer): Promise<string> {
  const address = await server.listen({ port: 0 })
  return `http://127.0.0.1:${address.port}`
}
