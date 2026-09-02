import { describe, expect, it, vi } from "vitest"

import {
  CANCEL_REPOSITORY_ANALYSIS,
  LOAD_REPOSITORY_ANALYSIS,
  createRepositoryAnalysisMessageHandler,
  createRepositoryAnalysisMessageLoader,
} from "../core/analyzer/messages"
import { GitHubApiError } from "../core/github/client"
import type { RepositoryAnalysis } from "../types/analysis"
import { supportedAnalysis } from "./analysisFixture"

const requestId = "01234567-89ab-cdef-0123-456789abcdef"
const repository = { owner: "acme", repo: "web" }

describe("repository analysis messages", () => {
  it("validates load messages and returns analysis", async () => {
    const load = vi.fn().mockResolvedValue(supportedAnalysis)
    const handle = createRepositoryAnalysisMessageHandler(load)

    await expect(
      handle({ type: LOAD_REPOSITORY_ANALYSIS, requestId, repository }),
    ).resolves.toEqual({ ok: true, requestId, analysis: supportedAnalysis })
    expect(load).toHaveBeenCalledWith(
      repository,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(handle({ type: LOAD_REPOSITORY_ANALYSIS, requestId: "bad" })).toBe(
      undefined,
    )
  })

  it("aborts the matching active background request", async () => {
    let receivedSignal: AbortSignal | undefined
    const load = vi.fn((_repository, options) => {
      receivedSignal = options.signal
      return new Promise<RepositoryAnalysis>(() => undefined)
    })
    const handle = createRepositoryAnalysisMessageHandler(load)

    void handle({ type: LOAD_REPOSITORY_ANALYSIS, requestId, repository })
    expect(receivedSignal?.aborted).toBe(false)

    handle({ type: CANCEL_REPOSITORY_ANALYSIS, requestId })
    expect(receivedSignal?.aborted).toBe(true)
  })

  it("serializes GitHub errors without leaking unknown errors", async () => {
    const githubFailure = createRepositoryAnalysisMessageHandler(() =>
      Promise.reject(new GitHubApiError("rate-limited", "wait", 403)),
    )
    const unknownFailure = createRepositoryAnalysisMessageHandler(() =>
      Promise.reject(new Error("sensitive detail")),
    )

    await expect(
      githubFailure({
        type: LOAD_REPOSITORY_ANALYSIS,
        requestId,
        repository,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "rate-limited", message: "wait", status: 403 },
    })
    await expect(
      unknownFailure({
        type: LOAD_REPOSITORY_ANALYSIS,
        requestId,
        repository,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unavailable",
        message: "Repository analysis could not be completed.",
      },
    })
  })

  it("loads a validated analysis response through the content transport", async () => {
    const send = vi.fn(async (message) => ({
      ok: true,
      requestId: message.requestId,
      analysis: supportedAnalysis,
    }))
    const load = createRepositoryAnalysisMessageLoader({ send })

    await expect(load(repository)).resolves.toEqual(supportedAnalysis)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: LOAD_REPOSITORY_ANALYSIS, repository }),
    )
  })

  it("rejects invalid responses and sends cancellation on abort", async () => {
    const invalidLoad = createRepositoryAnalysisMessageLoader({
      send: vi.fn().mockResolvedValue({ ok: true }),
    })

    await expect(invalidLoad(repository)).rejects.toMatchObject({
      code: "invalid-response",
    })

    const pendingSend = vi.fn((message) => {
      if (message.type === CANCEL_REPOSITORY_ANALYSIS) {
        return Promise.resolve(undefined)
      }

      return new Promise(() => undefined)
    })
    const cancellableLoad = createRepositoryAnalysisMessageLoader({
      send: pendingSend,
    })
    const controller = new AbortController()
    const promise = cancellableLoad(repository, { signal: controller.signal })

    controller.abort()

    await expect(promise).rejects.toMatchObject({ name: "AbortError" })
    expect(pendingSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: CANCEL_REPOSITORY_ANALYSIS }),
    )
  })
})
