import { describe, expect, it, vi } from "vitest"

import {
  BackendRuntimeApiClient,
  BackendRuntimeApiError,
} from "../core/backendRuntime/apiClient"
import type { BackendRuntime } from "../types/backendRuntime"

const runtime: BackendRuntime = {
  id: "runtime-00000001",
  repository: {
    repositoryId: 1,
    owner: "acme",
    name: "web",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
  },
  sourceRoot: "backend",
  adapterId: "express-node-npm-v1",
  status: "queued",
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  expiresAt: "2026-09-02T01:00:00.000Z",
}

const ACTIVE_SESSION = {
  token: "session-token",
  expiresAt: "2099-01-01T00:00:00.000Z",
}

describe("BackendRuntimeApiClient", () => {
  it("posts to v1/backend-runtimes with the stored session and never sends idempotency reuse of the preview path", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse(202, { created: true, runtime }))
    const client = new BackendRuntimeApiClient(
      "https://api.example.test/base/",
      { fetch, getSession: () => ACTIVE_SESSION },
    )

    await expect(client.create(runtime.repository, "backend")).resolves.toEqual(
      runtime,
    )

    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe(
      "https://api.example.test/base/v1/backend-runtimes",
    )
    expect(init).toMatchObject({
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      headers: expect.objectContaining({
        authorization: "Bearer session-token",
      }),
    })
    expect(JSON.parse(init?.body as string)).toEqual({
      repository: runtime.repository,
      contractVersion: "backend-v1",
      sourceRoot: "backend",
    })
  })

  it("gets and cancels a runtime by id", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse(200, runtime))
    const client = new BackendRuntimeApiClient("https://api.example.test/", {
      fetch,
      getSession: () => ACTIVE_SESSION,
    })

    await expect(client.get(runtime.id)).resolves.toEqual(runtime)

    fetch.mockResolvedValue(
      jsonResponse(202, { ...runtime, status: "cancelled" }),
    )
    await expect(client.cancel(runtime.id)).resolves.toMatchObject({
      status: "cancelled",
    })

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      new URL(`v1/backend-runtimes/${runtime.id}`, "https://api.example.test/"),
      expect.objectContaining({ method: "GET" }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      new URL(`v1/backend-runtimes/${runtime.id}`, "https://api.example.test/"),
      expect.objectContaining({ method: "DELETE" }),
    )
  })

  it("throws UNAUTHORIZED without a network call when there is no active session", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = new BackendRuntimeApiClient("https://api.example.test/", {
      fetch,
      getSession: () => null,
    })

    await expect(client.get(runtime.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("rejects a response whose runtime carries an unrecognized field shape (e.g. a url, or an internal dial target)", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse(200, {
        ...runtime,
        url: "https://evil.example/",
        // M9 phase 1 regression: the internal-only live dial target
        // (services/backend-runtime-worker/ports.ts's
        // BackendRuntimeDialTarget) must never surface here even if a
        // non-conformant server response included it or its fields
        // directly.
        dialTarget: { host: "10.99.0.2", port: 3000 },
        peerIp: "10.99.0.2",
        internalPort: 3000,
      }),
    )
    const client = new BackendRuntimeApiClient("https://api.example.test/", {
      fetch,
      getSession: () => ACTIVE_SESSION,
    })

    // Extra fields are simply ignored by the parser -- it never surfaces a
    // url, dial target, peer IP, or internal port even if a
    // (non-conformant) server response included one.
    const result = await client.get(runtime.id)
    expect(result).not.toHaveProperty("url")
    expect(result).not.toHaveProperty("dialTarget")
    expect(result).not.toHaveProperty("peerIp")
    expect(result).not.toHaveProperty("internalPort")
    expect(JSON.stringify(result)).not.toContain("10.99.0.2")
  })

  it("maps a typed API error response", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () =>
        jsonResponse(429, {
          error: { code: "RATE_LIMITED", message: "Only one active runtime." },
        }),
      )
    const client = new BackendRuntimeApiClient("https://api.example.test/", {
      fetch,
      getSession: () => ACTIVE_SESSION,
    })

    await expect(client.get(runtime.id)).rejects.toBeInstanceOf(
      BackendRuntimeApiError,
    )
    await expect(client.get(runtime.id)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
    })
  })

  it("clears the stored session on a 401 response", async () => {
    const clearSession = vi.fn()
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "no" } }),
      )
    const client = new BackendRuntimeApiClient("https://api.example.test/", {
      fetch,
      getSession: () => ACTIVE_SESSION,
      clearSession,
    })

    await expect(client.get(runtime.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    })
    expect(clearSession).toHaveBeenCalledOnce()
  })
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}
