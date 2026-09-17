import { describe, expect, it, vi } from "vitest"

import {
  CANCEL_REPOSITORY_DEPLOYMENTS,
  LOAD_REPOSITORY_DEPLOYMENTS,
  createLiveDeploymentMessageHandler,
  createLiveDeploymentMessageLoader,
} from "../core/github/liveDeploymentMessages"
import { GitHubApiError } from "../core/github/client"
import type { RepositoryLiveDeployment } from "../types/deployment"

const requestId = "01234567-89ab-cdef-0123-456789abcdef"
const repository = { owner: "acme", repo: "web" }
const notDetected: RepositoryLiveDeployment = {
  status: "not-detected",
  candidate: null,
  candidateCount: 0,
  truncated: false,
  evidence: [],
}
const confirmed: RepositoryLiveDeployment = {
  status: "confirmed",
  candidate: {
    environment: "production",
    productionEnvironment: true,
    url: "https://example.com",
    ref: "main",
    sha: "a".repeat(40),
    state: "success",
  },
  candidateCount: 1,
  truncated: false,
  evidence: [],
}

describe("live deployment messages", () => {
  it("validates load messages and returns the result", async () => {
    const load = vi.fn().mockResolvedValue(notDetected)
    const handle = createLiveDeploymentMessageHandler(load)

    await expect(
      handle({ type: LOAD_REPOSITORY_DEPLOYMENTS, requestId, repository }),
    ).resolves.toEqual({ ok: true, requestId, result: notDetected })
    expect(load).toHaveBeenCalledWith(
      repository,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it("ignores messages with a missing or malformed request id", () => {
    const load = vi.fn().mockResolvedValue(notDetected)
    const handle = createLiveDeploymentMessageHandler(load)

    expect(
      handle({
        type: LOAD_REPOSITORY_DEPLOYMENTS,
        requestId: "bad",
        repository,
      }),
    ).toBe(undefined)
    expect(handle({ type: "unrelated:message" })).toBe(undefined)
    expect(load).not.toHaveBeenCalled()
  })

  it("rejects a malformed repository identity before forwarding it", () => {
    const load = vi.fn().mockResolvedValue(notDetected)
    const handle = createLiveDeploymentMessageHandler(load)

    expect(
      handle({
        type: LOAD_REPOSITORY_DEPLOYMENTS,
        requestId,
        repository: { owner: "acme" },
      }),
    ).toBe(undefined)
    expect(load).not.toHaveBeenCalled()
  })

  it("aborts the matching active background request", async () => {
    let receivedSignal: AbortSignal | undefined
    const load = vi.fn((_repository, options) => {
      receivedSignal = options.signal
      return new Promise<RepositoryLiveDeployment>(() => undefined)
    })
    const handle = createLiveDeploymentMessageHandler(load)

    void handle({ type: LOAD_REPOSITORY_DEPLOYMENTS, requestId, repository })
    expect(receivedSignal?.aborted).toBe(false)

    handle({ type: CANCEL_REPOSITORY_DEPLOYMENTS, requestId })
    expect(receivedSignal?.aborted).toBe(true)
  })

  it("serializes GitHub errors without leaking unknown errors", async () => {
    const githubFailure = createLiveDeploymentMessageHandler(() =>
      Promise.reject(new GitHubApiError("rate-limited", "wait", 403)),
    )
    const unknownFailure = createLiveDeploymentMessageHandler(() =>
      Promise.reject(new Error("sensitive detail")),
    )

    await expect(
      githubFailure({
        type: LOAD_REPOSITORY_DEPLOYMENTS,
        requestId,
        repository,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "rate-limited", message: "wait", status: 403 },
    })
    await expect(
      unknownFailure({
        type: LOAD_REPOSITORY_DEPLOYMENTS,
        requestId,
        repository,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unavailable",
        message: "Deployment information is currently unavailable.",
      },
    })
  })

  it("loads a validated result through the content transport", async () => {
    const send = vi.fn(async (message) => ({
      ok: true,
      requestId: message.requestId,
      result: confirmed,
    }))
    const load = createLiveDeploymentMessageLoader({ send })

    await expect(load(repository)).resolves.toEqual(confirmed)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: LOAD_REPOSITORY_DEPLOYMENTS,
        repository,
      }),
    )
  })

  it("rejects a malformed result instead of forwarding it", async () => {
    const missingCandidate = createLiveDeploymentMessageLoader({
      send: vi.fn().mockResolvedValue({
        ok: true,
        result: { ...confirmed, candidate: null },
      }),
    })
    await expect(missingCandidate(repository)).rejects.toMatchObject({
      code: "invalid-response",
    })

    const badStatus = createLiveDeploymentMessageLoader({
      send: vi.fn().mockResolvedValue({
        ok: true,
        result: { ...notDetected, status: "confirmed-ish" },
      }),
    })
    await expect(badStatus(repository)).rejects.toMatchObject({
      code: "invalid-response",
    })

    const emptyResponse = createLiveDeploymentMessageLoader({
      send: vi.fn().mockResolvedValue({}),
    })
    await expect(emptyResponse(repository)).rejects.toMatchObject({
      code: "invalid-response",
    })
  })

  it("sends cancellation on abort and rejects with an AbortError", async () => {
    const pendingSend = vi.fn((message) => {
      if (message.type === CANCEL_REPOSITORY_DEPLOYMENTS) {
        return Promise.resolve(undefined)
      }

      return new Promise(() => undefined)
    })
    const cancellableLoad = createLiveDeploymentMessageLoader({
      send: pendingSend,
    })
    const controller = new AbortController()
    const promise = cancellableLoad(repository, { signal: controller.signal })

    controller.abort()

    await expect(promise).rejects.toMatchObject({ name: "AbortError" })
    expect(pendingSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: CANCEL_REPOSITORY_DEPLOYMENTS }),
    )
  })
})
