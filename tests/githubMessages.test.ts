import { describe, expect, it, vi } from "vitest"

import { GitHubApiError } from "../core/github/client"
import {
  CANCEL_REPOSITORY_METADATA,
  createRepositoryMetadataMessageHandler,
  createRepositoryMetadataMessageLoader,
  LOAD_REPOSITORY_METADATA,
  type RepositoryMetadataMessage,
} from "../core/github/messages"
import type {
  RepositoryMetadata,
  RepositoryMetadataLoader,
} from "../types/repository"

const metadata: RepositoryMetadata = {
  repositoryId: 10270250,
  owner: "react",
  repo: "react",
  defaultBranch: "main",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  homepage: "https://react.dev/",
}

describe("repository metadata message handler", () => {
  it("accepts only a validated repository identity", async () => {
    const loadRepositoryMetadata = vi
      .fn<RepositoryMetadataLoader>()
      .mockResolvedValue(metadata)
    const handleMessage = createRepositoryMetadataMessageHandler(
      loadRepositoryMetadata,
    )

    expect(handleMessage({ type: LOAD_REPOSITORY_METADATA })).toBeUndefined()
    expect(
      handleMessage({
        type: LOAD_REPOSITORY_METADATA,
        requestId: "12345678-1234-1234-1234-123456789012",
        repository: { owner: "react", repo: "../settings" },
      }),
    ).toBeUndefined()

    const response = await handleMessage({
      type: LOAD_REPOSITORY_METADATA,
      requestId: "12345678-1234-1234-1234-123456789012",
      repository: { owner: "react", repo: "react" },
    })

    expect(response).toEqual({
      ok: true,
      requestId: "12345678-1234-1234-1234-123456789012",
      metadata,
    })
    expect(loadRepositoryMetadata).toHaveBeenCalledTimes(1)
  })

  it("aborts an active background request when cancellation arrives", async () => {
    let requestSignal: AbortSignal | undefined
    const loadRepositoryMetadata = vi.fn<RepositoryMetadataLoader>(
      (_repository, options) => {
        requestSignal = options?.signal

        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          )
        })
      },
    )
    const handleMessage = createRepositoryMetadataMessageHandler(
      loadRepositoryMetadata,
    )
    const requestId = "12345678-1234-1234-1234-123456789012"
    const pendingResponse = handleMessage({
      type: LOAD_REPOSITORY_METADATA,
      requestId,
      repository: { owner: "react", repo: "react" },
    })

    handleMessage({ type: CANCEL_REPOSITORY_METADATA, requestId })

    expect(requestSignal?.aborted).toBe(true)
    await expect(pendingResponse).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" },
    })
  })

  it("serializes safe GitHub errors for the content script", async () => {
    const loadRepositoryMetadata = vi
      .fn<RepositoryMetadataLoader>()
      .mockRejectedValue(
        new GitHubApiError(
          "rate-limited",
          "Rate limited.",
          403,
          new Date("2030-01-01T00:00:00.000Z"),
        ),
      )
    const handleMessage = createRepositoryMetadataMessageHandler(
      loadRepositoryMetadata,
    )

    await expect(
      handleMessage({
        type: LOAD_REPOSITORY_METADATA,
        requestId: "12345678-1234-1234-1234-123456789012",
        repository: { owner: "react", repo: "react" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "rate-limited",
        status: 403,
        retryAt: "2030-01-01T00:00:00.000Z",
      },
    })
  })
})

describe("repository metadata message loader", () => {
  it("returns validated metadata from the background response", async () => {
    const send = vi.fn(
      async (message: RepositoryMetadataMessage): Promise<unknown> => ({
        ok: true,
        requestId: message.requestId,
        metadata,
      }),
    )
    const loadRepositoryMetadata = createRepositoryMetadataMessageLoader({
      send,
    })

    await expect(
      loadRepositoryMetadata({ owner: "react", repo: "react" }),
    ).resolves.toEqual(metadata)

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: LOAD_REPOSITORY_METADATA,
        repository: { owner: "react", repo: "react" },
      }),
    )
  })

  it("rejects invalid background responses", async () => {
    const loadRepositoryMetadata = createRepositoryMetadataMessageLoader({
      send: vi.fn().mockResolvedValue({ ok: true, metadata: "invalid" }),
    })

    await expect(
      loadRepositoryMetadata({ owner: "react", repo: "react" }),
    ).rejects.toMatchObject({ code: "invalid-response" })
  })

  it("forwards cancellation to the background request", async () => {
    const send = vi.fn(
      (message: RepositoryMetadataMessage): Promise<unknown> => {
        if (message.type === CANCEL_REPOSITORY_METADATA) {
          return Promise.resolve(undefined)
        }

        return new Promise(() => undefined)
      },
    )
    const loadRepositoryMetadata = createRepositoryMetadataMessageLoader({
      send,
    })
    const abortController = new AbortController()
    const request = loadRepositoryMetadata(
      { owner: "react", repo: "react" },
      { signal: abortController.signal },
    )

    abortController.abort()

    await expect(request).rejects.toMatchObject({ name: "AbortError" })
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: CANCEL_REPOSITORY_METADATA }),
    )
  })
})
