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

const FAR_FUTURE = "2099-01-01T00:00:00.000Z"

describe("PreviewApiClient", () => {
  it("calls fetch with a receiver that satisfies native fetch's own branding check", async () => {
    // Chrome's native `fetch` throws "Illegal invocation" unless invoked with
    // `this === globalThis` (or another WindowOrWorkerGlobalScope). Storing
    // `options.fetch ?? globalThis.fetch` without binding it, then calling it
    // as `this.fetch(...)`, reproduces exactly that failure in a real
    // browser while every other test here (which injects a plain vi.fn())
    // stays green either way. This test asserts the receiver explicitly
    // instead of relying on a real native fetch implementation.
    const originalFetch = globalThis.fetch
    const brandedFetch = function (
      this: unknown,
      url: string | URL | Request,
    ): ReturnType<typeof fetch> {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch': Illegal invocation")
      }
      return Promise.resolve(routedResponse(url))
    } as typeof fetch
    globalThis.fetch = brandedFetch

    try {
      const client = new PreviewApiClient("https://api.example.test/", {
        getToken: () => "ghp_test",
      })
      await expect(client.get(job.id)).resolves.toEqual(job)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("logs in once with the GitHub token, then uses the session for the actual request", async () => {
    const fetch = createRoutedFetch({
      jobResponse: () => jsonResponse(202, { created: true, job }),
    })
    const client = new PreviewApiClient("https://api.example.test/base/", {
      fetch,
      getToken: () => "ghp_the_real_token",
      createIdempotencyKey: () => "request-0000000001",
    })

    await expect(
      client.create({
        repository: job.repository,
        contractVersion: "static-v1",
      }),
    ).resolves.toEqual(job)

    expect(fetch).toHaveBeenCalledTimes(2)
    const [loginUrl, loginInit] = fetch.mock.calls[0]!
    expect(String(loginUrl)).toBe(
      "https://api.example.test/base/v1/auth/session",
    )
    expect(loginInit).toMatchObject({
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      headers: { authorization: "Bearer ghp_the_real_token" },
    })

    const [jobUrl, jobInit] = fetch.mock.calls[1]!
    expect(String(jobUrl)).toBe("https://api.example.test/base/v1/preview-jobs")
    expect(jobInit).toMatchObject({
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      headers: expect.objectContaining({
        "idempotency-key": "request-0000000001",
        authorization: "Bearer session-token",
      }),
    })
  })

  it("reuses a cached session across requests instead of logging in every time", async () => {
    const fetch = createRoutedFetch()
    const client = new PreviewApiClient("https://api.example.test/", {
      fetch,
      getToken: () => "ghp_test",
    })

    await client.get(job.id)
    await client.get(job.id)
    await client.cancel(job.id)

    const loginCalls = fetch.mock.calls.filter(([url]) =>
      String(url).endsWith("/v1/auth/session"),
    )
    expect(loginCalls).toHaveLength(1)
  })

  it("deduplicates concurrent logins into a single request", async () => {
    const fetch = createRoutedFetch()
    const client = new PreviewApiClient("https://api.example.test/", {
      fetch,
      getToken: () => "ghp_test",
    })

    await Promise.all([
      client.get(job.id),
      client.get(job.id),
      client.get(job.id),
    ])

    const loginCalls = fetch.mock.calls.filter(([url]) =>
      String(url).endsWith("/v1/auth/session"),
    )
    expect(loginCalls).toHaveLength(1)
  })

  it("discards an expired or rejected session and signs in again exactly once", async () => {
    let jobCallCount = 0
    const fetch = createRoutedFetch({
      jobResponse: () => {
        jobCallCount += 1
        return jobCallCount === 1
          ? new Response(null, { status: 401 })
          : jsonResponse(200, job)
      },
    })
    const client = new PreviewApiClient("https://api.example.test/", {
      fetch,
      getToken: () => "ghp_test",
    })

    await expect(client.get(job.id)).resolves.toEqual(job)

    const loginCalls = fetch.mock.calls.filter(([url]) =>
      String(url).endsWith("/v1/auth/session"),
    )
    expect(loginCalls).toHaveLength(2) // initial login + one retry login
    expect(jobCallCount).toBe(2) // the failed attempt, then the retry
  })

  it("never calls fetch at all when no GitHub token is configured", async () => {
    const fetch = createRoutedFetch()
    const client = new PreviewApiClient("https://api.example.test/", {
      fetch,
      getToken: () => null,
    })

    await expect(client.get(job.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("surfaces a rejected GitHub token as a structured login error", async () => {
    const fetch = createRoutedFetch({
      loginResponse: () =>
        new Response(
          JSON.stringify({
            error: {
              code: "UNAUTHORIZED",
              message: "This GitHub token is invalid.",
            },
          }),
          { status: 401 },
        ),
    })
    const client = new PreviewApiClient("https://api.example.test/", {
      fetch,
      getToken: () => "ghp_revoked",
    })

    await expect(client.get(job.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "This GitHub token is invalid.",
    })
  })

  it("reads and cancels only validated job ids", async () => {
    const fetch = createRoutedFetch()
    const client = new PreviewApiClient("https://api.example.test/", {
      fetch,
      getToken: () => "ghp_test",
    })

    await client.get(job.id)
    await client.cancel(job.id)

    expect(
      fetch.mock.calls
        .filter(([url]) => !String(url).endsWith("/v1/auth/session"))
        .map(([url, init]) => [String(url), init?.method]),
    ).toEqual([
      ["https://api.example.test/v1/preview-jobs/job-00000001", "GET"],
      ["https://api.example.test/v1/preview-jobs/job-00000001", "DELETE"],
    ])
    await expect(client.get("../unsafe")).rejects.toBeInstanceOf(
      PreviewApiError,
    )
  })

  it("returns sanitized structured service errors", async () => {
    const fetch = createRoutedFetch({
      jobResponse: () =>
        new Response(
          JSON.stringify({
            error: { code: "RATE_LIMITED", message: "Try later." },
          }),
          { status: 429, headers: { "retry-after": "60" } },
        ),
    })
    const client = new PreviewApiClient("https://api.example.test/", {
      fetch,
      getToken: () => "ghp_test",
    })

    await expect(client.get(job.id)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: "Try later.",
      status: 429,
      retryAfterSeconds: 60,
    })
  })

  it("rejects malformed success responses", async () => {
    const fetch = createRoutedFetch({
      jobResponse: () => jsonResponse(200, { status: "ready" }),
    })
    const client = new PreviewApiClient("https://api.example.test/", {
      fetch,
      getToken: () => "ghp_test",
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

function routedResponse(url: string | URL | Request): Response {
  const path = new URL(String(url instanceof Request ? url.url : url)).pathname
  return path.endsWith("/v1/auth/session")
    ? jsonResponse(200, { token: "session-token", expiresAt: FAR_FUTURE })
    : jsonResponse(200, job)
}

function createRoutedFetch(
  options: {
    loginResponse?: () => Response
    jobResponse?: () => Response
  } = {},
): ReturnType<typeof vi.fn<typeof globalThis.fetch>> {
  return vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) => {
    const path = new URL(String(url instanceof Request ? url.url : url))
      .pathname
    if (path.endsWith("/v1/auth/session")) {
      return (
        options.loginResponse?.() ??
        jsonResponse(200, { token: "session-token", expiresAt: FAR_FUTURE })
      )
    }
    return options.jobResponse?.() ?? jsonResponse(200, job)
  })
}
