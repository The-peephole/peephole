import { describe, expect, it } from "vitest"

import { GitHubApiError } from "../core/github/client"
import { BackendRuntimeControlPlane } from "../services/backend-runtime-api/controlPlane"
import {
  InMemoryBackendRuntimeQueue,
  InMemoryBackendRuntimeStore,
} from "../services/backend-runtime-api/inMemoryAdapters"
import {
  createBackendRuntimeHttpHandler,
  isBackendRuntimeHttpPath,
} from "../services/backend-runtime-api/http"
import type { BackendRuntimePlan } from "../types/backendRuntime"

const repository = {
  repositoryId: 1,
  owner: "acme",
  name: "web",
  commitSha: "a".repeat(40),
}

const plan: BackendRuntimePlan = {
  contractVersion: "backend-v1",
  repository,
  sourceRoot: "backend",
  adapterId: "express-node-npm-v1",
  packageManager: "npm",
  install: { command: "npm", args: ["ci"] },
  start: { command: "node", args: ["src/server.js"] },
  internalPort: 3000,
  platformEnvironment: {
    PORT: "3000",
    HOST: "0.0.0.0",
    NODE_ENV: "production",
  },
  generatedSecretNames: [],
  databaseRequirement: null,
}

function compose(
  resolve: () => Promise<BackendRuntimePlan | null> = async () => plan,
) {
  return composeContext(resolve).handle
}

function composeContext(
  resolve: () => Promise<BackendRuntimePlan | null> = async () => plan,
) {
  const store = new InMemoryBackendRuntimeStore()
  const queue = new InMemoryBackendRuntimeQueue()
  const controlPlane = new BackendRuntimeControlPlane(
    { resolve },
    store,
    queue,
    {
      now: () => new Date("2026-09-01T00:00:00.000Z"),
    },
  )
  return {
    controlPlane,
    handle: createBackendRuntimeHttpHandler(controlPlane),
  }
}

const requester = { subject: "user-1", ip: "203.0.113.10" }

describe("isBackendRuntimeHttpPath", () => {
  it("matches only backend-runtime routes", () => {
    expect(isBackendRuntimeHttpPath("/v1/backend-runtimes")).toBe(true)
    expect(isBackendRuntimeHttpPath("/v1/backend-runtimes/abc12345")).toBe(true)
    expect(isBackendRuntimeHttpPath("/v1/preview-jobs")).toBe(false)
    expect(isBackendRuntimeHttpPath("/v1/preview-jobs/abc12345")).toBe(false)
  })
})

describe("createBackendRuntimeHttpHandler", () => {
  it("creates a runtime and never returns a URL field", async () => {
    const handle = compose()

    const response = await handle({
      method: "POST",
      path: "/v1/backend-runtimes",
      headers: {},
      body: { repository, contractVersion: "backend-v1" },
      requester,
    })

    expect(response.status).toBe(202)
    expect(JSON.stringify(response.body).toLowerCase()).not.toContain("url")
    expect(JSON.stringify(response.body)).not.toContain("generatedSecretNames")
  })

  it("returns only the safe SECRET_UNAVAILABLE code and message", async () => {
    const { controlPlane, handle } = composeContext()
    const created = await handle({
      method: "POST",
      path: "/v1/backend-runtimes",
      headers: {},
      body: { repository, contractVersion: "backend-v1" },
      requester,
    })
    const id = (created.body as { runtime: { id: string } }).runtime.id
    await controlPlane.fail(id, "SECRET_UNAVAILABLE")

    const response = await handle({
      method: "GET",
      path: `/v1/backend-runtimes/${id}`,
      headers: {},
      requester,
    })

    expect(response).toMatchObject({
      status: 200,
      body: {
        errorCode: "SECRET_UNAVAILABLE",
        errorMessage:
          "The backend runtime's secret material is no longer available. Start a new preview.",
      },
    })
    const serialized = JSON.stringify(response.body)
    expect(serialized).not.toContain("generatedSecretNames")
    expect(serialized).not.toContain("GeneratedSecretMaterial")
    expect(serialized).not.toContain("values")
  })

  it("gets and cancels a runtime by id", async () => {
    const handle = compose()
    const created = await handle({
      method: "POST",
      path: "/v1/backend-runtimes",
      headers: {},
      body: { repository, contractVersion: "backend-v1" },
      requester,
    })
    const id = (created.body as { runtime: { id: string } }).runtime.id

    const got = await handle({
      method: "GET",
      path: `/v1/backend-runtimes/${id}`,
      headers: {},
      requester,
    })
    expect(got.status).toBe(200)

    const cancelled = await handle({
      method: "DELETE",
      path: `/v1/backend-runtimes/${id}`,
      headers: {},
      requester,
    })
    expect(cancelled.status).toBe(202)
  })

  it("rejects a malformed create body", async () => {
    const handle = compose()

    const response = await handle({
      method: "POST",
      path: "/v1/backend-runtimes",
      headers: {},
      body: { repository: {} },
      requester,
    })

    expect(response.status).toBe(400)
  })

  it.each(["orchestrationKey", "databaseRequirement"])(
    "rejects client injection of internal field %s",
    async (field) => {
      const handle = compose()

      const response = await handle({
        method: "POST",
        path: "/v1/backend-runtimes",
        headers: {},
        body: {
          repository,
          contractVersion: "backend-v1",
          [field]: field === "orchestrationKey" ? "fullstack-client" : null,
        },
        requester,
      })

      expect(response).toMatchObject({
        status: 400,
        body: { error: { code: "INVALID_REQUEST" } },
      })
    },
  )

  it("returns 404 for an unknown route", async () => {
    const handle = compose()

    const response = await handle({
      method: "GET",
      path: "/v1/unknown",
      headers: {},
      requester,
    })

    expect(response.status).toBe(404)
  })

  it("returns a safe 503 with Retry-After for a GitHub upstream rate-limit failure", async () => {
    const handle = compose(async () => {
      throw new GitHubApiError(
        "rate-limited",
        "GitHub API rate limit reached.",
        403,
        new Date("2026-09-01T00:01:00.000Z"),
      )
    })

    const response = await handle({
      method: "POST",
      path: "/v1/backend-runtimes",
      headers: {},
      body: { repository, contractVersion: "backend-v1" },
      requester,
    })

    expect(response).toMatchObject({
      status: 503,
      headers: { "retry-after": "60" },
      body: { error: { code: "UPSTREAM_UNAVAILABLE" } },
    })
  })

  it("still returns the existing generic safe 500 for an unexpected exception, not a fabricated 503", async () => {
    const handle = compose(async () => {
      throw new Error("unexpected resolver bug")
    })

    const response = await handle({
      method: "POST",
      path: "/v1/backend-runtimes",
      headers: {},
      body: { repository, contractVersion: "backend-v1" },
      requester,
    })

    expect(response).toMatchObject({
      status: 500,
      body: { error: { code: "INTERNAL_ERROR" } },
    })
    expect(JSON.stringify(response)).not.toContain("unexpected resolver bug")
  })
})
