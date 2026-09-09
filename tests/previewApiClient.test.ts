import { describe, expect, it, vi } from "vitest"

import { PreviewApiClient, PreviewApiError } from "../core/preview/apiClient"
import {
  getPreviewApiHostPermission,
  parsePreviewApiBaseUrl,
} from "../core/preview/config"
import type { PreviewJob } from "../types/preview"

const job: PreviewJob = {
  id: "job-00000001",
  repository: {
    repositoryId: 1,
    owner: "acme",
    name: "web",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
  },
  plan: {
    contractVersion: "static-v1",
    repository: {
      repositoryId: 1,
      owner: "acme",
      name: "web",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
    },
    sourceRoot: ".",
    packageManager: "npm",
    installCommand: "npm ci",
    buildCommand: "npm run build",
    outputDirectory: "dist",
  },
  cacheKey: "cache-key",
  cacheStatus: "miss",
  status: "queued",
  artifact: null,
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

describe("PreviewApiClient", () => {
  it("calls native fetch with the correct receiver", async () => {
    const originalFetch = globalThis.fetch
    const brandedFetch = function (
      this: unknown,
      url: string | URL | Request,
    ): ReturnType<typeof fetch> {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch': Illegal invocation")
      }
      void url
      return Promise.resolve(jsonResponse(200, job))
    } as typeof fetch
    globalThis.fetch = brandedFetch

    try {
      const client = new PreviewApiClient("https://api.example.test/", {
        getSession: () => ACTIVE_SESSION,
      })
      await expect(client.get(job.id)).resolves.toEqual(job)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("uses only the stored Peephole session for preview requests", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse(202, { created: true, job }))
    const client = new PreviewApiClient("https://api.example.test/base/", {
      fetch,
      getSession: () => ACTIVE_SESSION,
      createIdempotencyKey: () => "request-0000000001",
    })

    await expect(
      client.create({
        repository: job.repository,
        contractVersion: "static-v1",
      }),
    ).resolves.toEqual(job)

    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe("https://api.example.test/base/v1/preview-jobs")
    expect(init).toMatchObject({
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      headers: expect.objectContaining({
        "idempotency-key": "request-0000000001",
        authorization: "Bearer session-token",
      }),
    })
    expect(JSON.stringify(init)).not.toContain("ghp_")
    expect(JSON.stringify(init)).not.toContain("ghu_")
  })

  it("clears a rejected session and requires an explicit reconnect", async () => {
    const clearSession = vi.fn()
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse(401, {
        error: { code: "UNAUTHORIZED", message: "Session expired." },
      }),
    )
    const client = new PreviewApiClient("https://api.example.test/", {
      fetch,
      getSession: () => ACTIVE_SESSION,
      clearSession,
    })

    await expect(client.get(job.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Session expired.",
    })
    expect(clearSession).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("does not call the API without a Peephole session", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const clearSession = vi.fn()
    const client = new PreviewApiClient("https://api.example.test/", {
      fetch,
      getSession: () => null,
      clearSession,
    })

    await expect(client.get(job.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Connect GitHub to build a preview.",
    })
    expect(clearSession).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("rejects an expired stored session before making a request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const clearSession = vi.fn()
    const client = new PreviewApiClient("https://api.example.test/", {
      fetch,
      getSession: () => ({
        token: "expired-session",
        expiresAt: "2020-01-01T00:00:00.000Z",
      }),
      clearSession,
    })

    await expect(client.get(job.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    })
    expect(clearSession).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("reads and cancels only validated job ids", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => jsonResponse(200, job))
    const client = new PreviewApiClient("https://api.example.test/", {
      fetch,
      getSession: () => ACTIVE_SESSION,
    })

    await client.get(job.id)
    await client.cancel(job.id)

    expect(
      fetch.mock.calls.map(([url, init]) => [String(url), init?.method]),
    ).toEqual([
      ["https://api.example.test/v1/preview-jobs/job-00000001", "GET"],
      ["https://api.example.test/v1/preview-jobs/job-00000001", "DELETE"],
    ])
    await expect(client.get("../unsafe")).rejects.toBeInstanceOf(
      PreviewApiError,
    )
  })

  it("returns sanitized structured service errors", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "RATE_LIMITED", message: "Try later." },
        }),
        { status: 429, headers: { "retry-after": "60" } },
      ),
    )
    const client = new PreviewApiClient("https://api.example.test/", {
      fetch,
      getSession: () => ACTIVE_SESSION,
    })

    await expect(client.get(job.id)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: "Try later.",
      status: 429,
      retryAfterSeconds: 60,
    })
  })

  it("rejects malformed success responses", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse(200, { status: "ready" }))
    const client = new PreviewApiClient("https://api.example.test/", {
      fetch,
      getSession: () => ACTIVE_SESSION,
    })

    await expect(client.get(job.id)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    })
  })
})

describe("preview API configuration", () => {
  it("accepts HTTPS and local development HTTP URLs", () => {
    expect(parsePreviewApiBaseUrl("https://api.example.test/control")).toBe(
      "https://api.example.test/control/",
    )
    expect(parsePreviewApiBaseUrl("http://localhost:8787")).toBe(
      "http://localhost:8787/",
    )
    expect(
      getPreviewApiHostPermission("https://api.example.test/control/"),
    ).toBe("https://api.example.test/*")
  })

  it("rejects insecure remote or credential-bearing URLs", () => {
    expect(() => parsePreviewApiBaseUrl("http://example.test")).toThrow("HTTPS")
    expect(() =>
      parsePreviewApiBaseUrl("https://user:pass@example.test"),
    ).toThrow("credentials")
  })
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}
