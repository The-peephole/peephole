import { describe, expect, it } from "vitest"

import { GitHubApiError } from "../core/github/client"
import { FullStackPreviewControlPlane } from "../services/fullstack-preview-api/controlPlane"
import {
  createFullStackPreviewHttpHandler,
  isFullStackPreviewHttpPath,
} from "../services/fullstack-preview-api/http"
import {
  FakeBackendPlanResolver,
  FakeFrontendPlanResolver,
  FakeFullStackPreviewQueue,
  FakeFullStackPreviewStore,
  repository,
} from "./support/fakeFullStackPreview"

const requester = { subject: "user-1", ip: "203.0.113.10" }
const idempotencyKey = "request-key-0123456789abcdef"

function compose(
  frontendResolver = new FakeFrontendPlanResolver(),
  backendResolver = new FakeBackendPlanResolver(),
) {
  const store = new FakeFullStackPreviewStore()
  const queue = new FakeFullStackPreviewQueue()
  const controlPlane = new FullStackPreviewControlPlane(
    frontendResolver,
    backendResolver,
    store,
    queue,
    { consume: async () => ({ allowed: true as const }) },
    { now: () => new Date("2026-01-01T00:00:00.000Z") },
  )
  return createFullStackPreviewHttpHandler(controlPlane)
}

const validBody = {
  contractVersion: "fullstack-v1",
  repository,
  frontendTarget: { sourceRoot: "frontend" },
  backendSourceRoot: "backend",
}

describe("isFullStackPreviewHttpPath", () => {
  it("matches only full-stack preview routes", () => {
    expect(isFullStackPreviewHttpPath("/v1/fullstack-previews")).toBe(true)
    expect(
      isFullStackPreviewHttpPath("/v1/fullstack-previews/fullstack-abc12345"),
    ).toBe(true)
    expect(isFullStackPreviewHttpPath("/v1/preview-jobs")).toBe(false)
    expect(isFullStackPreviewHttpPath("/v1/backend-runtimes")).toBe(false)
  })
})

describe("createFullStackPreviewHttpHandler", () => {
  it("requires an Idempotency-Key header", async () => {
    const handle = compose()
    const response = await handle({
      method: "POST",
      path: "/v1/fullstack-previews",
      headers: {},
      body: validBody,
      requester,
    })
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: { code: "INVALID_REQUEST" } })
  })

  it("creates a preview: 202 when newly queued, 200 on an idempotent replay", async () => {
    const handle = compose()
    const create = () =>
      handle({
        method: "POST",
        path: "/v1/fullstack-previews",
        headers: { "idempotency-key": idempotencyKey },
        body: validBody,
        requester,
      })

    const first = await create()
    expect(first.status).toBe(202)

    const second = await create()
    expect(second.status).toBe(200)
    expect((second.body as { preview: { id: string } }).preview.id).toBe(
      (first.body as { preview: { id: string } }).preview.id,
    )
  })

  it("gets and cancels a preview by id", async () => {
    const handle = compose()
    const created = await handle({
      method: "POST",
      path: "/v1/fullstack-previews",
      headers: { "idempotency-key": idempotencyKey },
      body: validBody,
      requester,
    })
    const id = (created.body as { preview: { id: string } }).preview.id

    const got = await handle({
      method: "GET",
      path: `/v1/fullstack-previews/${id}`,
      headers: {},
      requester,
    })
    expect(got.status).toBe(200)

    const cancelled = await handle({
      method: "DELETE",
      path: `/v1/fullstack-previews/${id}`,
      headers: {},
      requester,
    })
    expect(cancelled.status).toBe(202)
  })

  it("a different requester's GET/DELETE is 404, never 403", async () => {
    const handle = compose()
    const created = await handle({
      method: "POST",
      path: "/v1/fullstack-previews",
      headers: { "idempotency-key": idempotencyKey },
      body: validBody,
      requester,
    })
    const id = (created.body as { preview: { id: string } }).preview.id
    const other = { subject: "user-2", ip: "203.0.113.20" }

    const got = await handle({
      method: "GET",
      path: `/v1/fullstack-previews/${id}`,
      headers: {},
      requester: other,
    })
    expect(got.status).toBe(404)

    const cancelled = await handle({
      method: "DELETE",
      path: `/v1/fullstack-previews/${id}`,
      headers: {},
      requester: other,
    })
    expect(cancelled.status).toBe(404)
  })

  it("rejects unknown top-level fields", async () => {
    const handle = compose()
    const response = await handle({
      method: "POST",
      path: "/v1/fullstack-previews",
      headers: { "idempotency-key": idempotencyKey },
      body: { ...validBody, extra: "nope" },
      requester,
    })
    expect(response.status).toBe(400)
  })

  it("accepts the case-insensitive HTTP spelling of Idempotency-Key", async () => {
    const handle = compose()
    const response = await handle({
      method: "POST",
      path: "/v1/fullstack-previews",
      headers: { "Idempotency-Key": idempotencyKey },
      body: validBody,
      requester,
    })

    expect(response.status).toBe(202)
  })

  it.each([
    [
      "a backend host/port target",
      { backendHost: "10.0.0.1", backendPort: 3000 },
    ],
    [
      "a peerIp/dialTarget",
      { peerIp: "10.0.0.1", dialTarget: { host: "10.0.0.1", port: 3000 } },
    ],
    [
      "an internal id",
      { frontendJobId: "job-1", backendRuntimeId: "runtime-1" },
    ],
    [
      "a hostname/url",
      { hostname: "fullstack-x.example.com", url: "https://evil.example/" },
    ],
    ["an arbitrary command", { command: "rm -rf /" }],
  ])(
    "no arbitrary backend/network field parses successfully: %s",
    async (_label, extraFields) => {
      const handle = compose()
      const response = await handle({
        method: "POST",
        path: "/v1/fullstack-previews",
        headers: { "idempotency-key": idempotencyKey },
        body: { ...validBody, ...extraFields },
        requester,
      })
      expect(response.status).toBe(400)
    },
  )

  it("never returns dialTarget/peerIp/internalPort/frontendJobId/artifactId/backendRuntimeId in any response, and url is null", async () => {
    const handle = compose()
    const created = await handle({
      method: "POST",
      path: "/v1/fullstack-previews",
      headers: { "idempotency-key": idempotencyKey },
      body: validBody,
      requester,
    })
    const serialized = JSON.stringify(created.body)
    for (const forbidden of [
      "dialTarget",
      "peerIp",
      "internalPort",
      "frontendJobId",
      "artifactId",
      "backendRuntimeId",
      "requesterId",
      "requestFingerprint",
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
    expect(
      (created.body as { preview: { url: unknown } }).preview.url,
    ).toBeNull()
  })

  it("404s a GET for an id that was never created", async () => {
    const handle = compose()
    const response = await handle({
      method: "GET",
      path: "/v1/fullstack-previews/fullstack-00000000-0000-0000-0000-000000000000",
      headers: {},
      requester,
    })
    expect(response.status).toBe(404)
  })

  it("404s a completely unmatched path", async () => {
    const handle = compose()
    const response = await handle({
      method: "GET",
      path: "/v1/fullstack-previews/",
      headers: {},
      requester,
    })
    expect(response.status).toBe(404)
  })

  it("returns a safe 503 with Retry-After for a GitHub upstream rate-limit failure", async () => {
    const frontendResolver = new FakeFrontendPlanResolver()
    frontendResolver.nextError = new GitHubApiError(
      "rate-limited",
      "GitHub API rate limit reached.",
      403,
      new Date("2026-01-01T00:01:00.000Z"),
    )
    const handle = compose(frontendResolver)

    const response = await handle({
      method: "POST",
      path: "/v1/fullstack-previews",
      headers: { "idempotency-key": idempotencyKey },
      body: validBody,
      requester,
    })

    expect(response).toMatchObject({
      status: 503,
      headers: { "retry-after": "60" },
      body: { error: { code: "UPSTREAM_UNAVAILABLE" } },
    })
  })

  it("still returns the existing generic safe 500 for an unexpected exception, not a fabricated 503", async () => {
    const backendResolver = new FakeBackendPlanResolver()
    backendResolver.nextError = new Error("unexpected resolver bug")
    const handle = compose(new FakeFrontendPlanResolver(), backendResolver)

    const response = await handle({
      method: "POST",
      path: "/v1/fullstack-previews",
      headers: { "idempotency-key": idempotencyKey },
      body: validBody,
      requester,
    })

    expect(response).toMatchObject({
      status: 500,
      body: { error: { code: "INTERNAL_ERROR" } },
    })
    expect(JSON.stringify(response)).not.toContain("unexpected resolver bug")
  })
})
