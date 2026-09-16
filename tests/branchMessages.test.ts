import { describe, expect, it, vi } from "vitest"

import {
  CANCEL_REPOSITORY_BRANCHES,
  LIST_REPOSITORY_BRANCHES,
  createRepositoryBranchesMessageHandler,
  createRepositoryBranchesMessageLoader,
} from "../core/github/branchMessages"
import { GitHubApiError, MAX_REPOSITORY_BRANCHES } from "../core/github/client"
import type { RepositoryBranchList } from "../types/repository"

const requestId = "01234567-89ab-cdef-0123-456789abcdef"
const repository = { owner: "acme", repo: "web" }
const branchList: RepositoryBranchList = {
  defaultBranch: "main",
  branches: ["main", "feature/login", "release-1.2.3"],
  truncated: false,
}

describe("repository branches messages", () => {
  it("validates list messages and returns the branch list", async () => {
    const load = vi.fn().mockResolvedValue(branchList)
    const handle = createRepositoryBranchesMessageHandler(load)

    await expect(
      handle({ type: LIST_REPOSITORY_BRANCHES, requestId, repository }),
    ).resolves.toEqual({ ok: true, requestId, result: branchList })
    expect(load).toHaveBeenCalledWith(
      repository,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it("ignores messages with a missing or malformed request id", () => {
    const load = vi.fn().mockResolvedValue(branchList)
    const handle = createRepositoryBranchesMessageHandler(load)

    expect(
      handle({ type: LIST_REPOSITORY_BRANCHES, requestId: "bad", repository }),
    ).toBe(undefined)
    expect(handle({ type: "unrelated:message" })).toBe(undefined)
    expect(load).not.toHaveBeenCalled()
  })

  it("rejects a malformed repository identity before forwarding it", () => {
    const load = vi.fn().mockResolvedValue(branchList)
    const handle = createRepositoryBranchesMessageHandler(load)

    expect(
      handle({
        type: LIST_REPOSITORY_BRANCHES,
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
      return new Promise<RepositoryBranchList>(() => undefined)
    })
    const handle = createRepositoryBranchesMessageHandler(load)

    void handle({ type: LIST_REPOSITORY_BRANCHES, requestId, repository })
    expect(receivedSignal?.aborted).toBe(false)

    handle({ type: CANCEL_REPOSITORY_BRANCHES, requestId })
    expect(receivedSignal?.aborted).toBe(true)
  })

  it("serializes GitHub errors without leaking unknown errors", async () => {
    const githubFailure = createRepositoryBranchesMessageHandler(() =>
      Promise.reject(new GitHubApiError("rate-limited", "wait", 403)),
    )
    const unknownFailure = createRepositoryBranchesMessageHandler(() =>
      Promise.reject(new Error("sensitive detail")),
    )

    await expect(
      githubFailure({ type: LIST_REPOSITORY_BRANCHES, requestId, repository }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "rate-limited", message: "wait", status: 403 },
    })
    await expect(
      unknownFailure({ type: LIST_REPOSITORY_BRANCHES, requestId, repository }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unavailable",
        message: "Repository branches could not be loaded.",
      },
    })
  })

  it("loads a validated branch list through the content transport", async () => {
    const send = vi.fn(async (message) => ({
      ok: true,
      requestId: message.requestId,
      result: branchList,
    }))
    const load = createRepositoryBranchesMessageLoader({ send })

    await expect(load(repository)).resolves.toEqual(branchList)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: LIST_REPOSITORY_BRANCHES,
        repository,
      }),
    )
  })

  it("rejects a malformed branch-list response instead of forwarding it", async () => {
    const missingDefault = createRepositoryBranchesMessageLoader({
      send: vi.fn().mockResolvedValue({
        ok: true,
        result: { defaultBranch: "main", branches: [], truncated: false },
      }),
    })
    await expect(missingDefault(repository)).rejects.toMatchObject({
      code: "invalid-response",
    })

    const duplicateBranches = createRepositoryBranchesMessageLoader({
      send: vi.fn().mockResolvedValue({
        ok: true,
        result: {
          defaultBranch: "main",
          branches: ["main", "main"],
          truncated: false,
        },
      }),
    })
    await expect(duplicateBranches(repository)).rejects.toMatchObject({
      code: "invalid-response",
    })

    const defaultNotListed = createRepositoryBranchesMessageLoader({
      send: vi.fn().mockResolvedValue({
        ok: true,
        result: {
          defaultBranch: "main",
          branches: ["develop"],
          truncated: false,
        },
      }),
    })
    await expect(defaultNotListed(repository)).rejects.toMatchObject({
      code: "invalid-response",
    })

    const emptyResponse = createRepositoryBranchesMessageLoader({
      send: vi.fn().mockResolvedValue({}),
    })
    await expect(emptyResponse(repository)).rejects.toMatchObject({
      code: "invalid-response",
    })
  })

  it("rejects a branch list that exceeds the bounded maximum", async () => {
    const tooMany = createRepositoryBranchesMessageLoader({
      send: vi.fn().mockResolvedValue({
        ok: true,
        result: {
          defaultBranch: "main",
          branches: Array.from(
            { length: MAX_REPOSITORY_BRANCHES + 1 },
            (_, index) => (index === 0 ? "main" : `branch-${index}`),
          ),
          truncated: true,
        },
      }),
    })

    await expect(tooMany(repository)).rejects.toMatchObject({
      code: "invalid-response",
    })
  })

  it("sends cancellation on abort and rejects with an AbortError", async () => {
    const pendingSend = vi.fn((message) => {
      if (message.type === CANCEL_REPOSITORY_BRANCHES) {
        return Promise.resolve(undefined)
      }

      return new Promise(() => undefined)
    })
    const cancellableLoad = createRepositoryBranchesMessageLoader({
      send: pendingSend,
    })
    const controller = new AbortController()
    const promise = cancellableLoad(repository, { signal: controller.signal })

    controller.abort()

    await expect(promise).rejects.toMatchObject({ name: "AbortError" })
    expect(pendingSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: CANCEL_REPOSITORY_BRANCHES }),
    )
  })
})
