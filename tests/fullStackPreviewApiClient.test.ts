import { describe, expect, it, vi } from "vitest"

import {
  FullStackPreviewApiClient,
  FullStackPreviewApiError,
} from "../core/fullstack/apiClient"
import { isTrustedFullStackPreviewUrl } from "../core/preview/config"
import type { FullStackPreview } from "../types/fullstackPreview"

const preview: FullStackPreview = {
  id: "fullstack-12345678-1234-1234-1234-123456789abc",
  repository: {
    repositoryId: 1371618449,
    owner: "The-peephole",
    name: "peephole-fixture-fullstack",
    commitSha: "fecbe5976d6498e75e7a8455319097814457b472",
  },
  frontendSourceRoot: "frontend",
  backendSourceRoot: "backend",
  status: "queued",
  url: null,
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z",
  expiresAt: "2026-10-08T00:15:00.000Z",
}

const session = {
  token: "peephole-session",
  expiresAt: "2099-01-01T00:00:00.000Z",
}

describe("FullStackPreviewApiClient", () => {
  it("creates a pinned fullstack-v1 request with bearer auth and idempotency", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse(202, { created: true, preview }))
    const client = new FullStackPreviewApiClient(
      "https://api.example.test/control/",
      {
        fetch,
        getSession: () => session,
        createIdempotencyKey: () => "fullstack-request-0001",
      },
    )

    await expect(
      client.create({
        contractVersion: "fullstack-v1",
        repository: preview.repository,
        frontendTarget: { sourceRoot: "frontend" },
        backendSourceRoot: "backend",
      }),
    ).resolves.toEqual(preview)

    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe(
      "https://api.example.test/control/v1/fullstack-previews",
    )
    expect(init).toMatchObject({
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      headers: expect.objectContaining({
        authorization: "Bearer peephole-session",
        "idempotency-key": "fullstack-request-0001",
      }),
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      contractVersion: "fullstack-v1",
      repository: preview.repository,
      frontendTarget: { sourceRoot: "frontend" },
      backendSourceRoot: "backend",
    })
  })

  it("gets and stops only canonical full-stack ids", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => jsonResponse(200, preview))
    const client = new FullStackPreviewApiClient("https://api.example.test/", {
      fetch,
      getSession: () => session,
    })

    await client.get(preview.id)
    await client.stop(preview.id)
    expect(
      fetch.mock.calls.map(([url, init]) => [String(url), init?.method]),
    ).toEqual([
      [`https://api.example.test/v1/fullstack-previews/${preview.id}`, "GET"],
      [
        `https://api.example.test/v1/fullstack-previews/${preview.id}`,
        "DELETE",
      ],
    ])
    await expect(client.get("../unsafe")).rejects.toBeInstanceOf(
      FullStackPreviewApiError,
    )
  })

  it("clears a rejected session and distinguishes HTTP from network errors", async () => {
    const clearSession = vi.fn()
    const rejected = new FullStackPreviewApiClient(
      "https://api.example.test/",
      {
        fetch: vi.fn().mockResolvedValue(
          jsonResponse(401, {
            error: { code: "UNAUTHORIZED", message: "Session expired." },
          }),
        ),
        getSession: () => session,
        clearSession,
      },
    )
    await expect(rejected.get(preview.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      status: 401,
    })
    expect(clearSession).toHaveBeenCalledOnce()

    const offline = new FullStackPreviewApiClient("https://api.example.test/", {
      fetch: vi.fn().mockRejectedValue(new TypeError("offline")),
      getSession: () => session,
    })
    await expect(offline.get(preview.id)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      status: null,
    })
  })

  it("rejects malformed success responses", async () => {
    const client = new FullStackPreviewApiClient("https://api.example.test/", {
      fetch: vi.fn().mockResolvedValue(
        jsonResponse(200, {
          ...preview,
          status: "ready",
          url: "https://attacker.example/",
          repository: { ...preview.repository, repositoryId: "1" },
        }),
      ),
      getSession: () => session,
    })

    await expect(client.get(preview.id)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    })
  })
})

describe("full-stack preview URL policy", () => {
  it.each([
    [
      "https://fullstack-12345678-1234-1234-1234-123456789abc.preview.example/",
      true,
    ],
    [
      "http://fullstack-12345678-1234-1234-1234-123456789abc.preview.example/",
      false,
    ],
    [
      "https://fullstack-12345678-1234-1234-1234-123456789abc.preview.example:443/",
      false,
    ],
    [
      "https://fullstack-12345678-1234-1234-1234-123456789abc.preview.example/?next=evil",
      false,
    ],
    [
      "https://fullstack-12345678-1234-1234-1234-123456789abc.preview.example/path",
      false,
    ],
    [
      "https://fullstack-12345678-1234-1234-1234-123456789abc.evil.example/",
      false,
    ],
    [
      "https://artifact-12345678-1234-1234-1234-123456789abc.preview.example/",
      false,
    ],
  ])("validates %s", (url, expected) => {
    expect(
      isTrustedFullStackPreviewUrl(
        url,
        "preview.example",
        "fullstack-12345678-1234-1234-1234-123456789abc",
      ),
    ).toBe(expected)
  })
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}
