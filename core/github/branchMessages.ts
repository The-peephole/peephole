import type {
  RepositoryBranchList,
  RepositoryBranchesLoader,
  RepositoryIdentity,
} from "../../types/repository"
import {
  GitHubApiError,
  type GitHubApiErrorCode,
  MAX_REPOSITORY_BRANCHES,
} from "./client"
import { isRepositoryBranchName, isRepositoryIdentity } from "./repositoryRef"

export const LIST_REPOSITORY_BRANCHES =
  "peephole:github:list-repository-branches"
export const CANCEL_REPOSITORY_BRANCHES =
  "peephole:github:cancel-repository-branches"

interface ListRepositoryBranchesMessage {
  type: typeof LIST_REPOSITORY_BRANCHES
  requestId: string
  repository: RepositoryIdentity
}

interface CancelRepositoryBranchesMessage {
  type: typeof CANCEL_REPOSITORY_BRANCHES
  requestId: string
}

type RepositoryBranchesMessage =
  ListRepositoryBranchesMessage | CancelRepositoryBranchesMessage

interface RepositoryBranchesSuccessResponse {
  ok: true
  requestId: string
  result: RepositoryBranchList
}

interface RepositoryBranchesErrorResponse {
  ok: false
  requestId: string
  error: {
    code: GitHubApiErrorCode | "aborted"
    message: string
    status: number | null
    retryAt: string | null
  }
}

type RepositoryBranchesResponse =
  RepositoryBranchesSuccessResponse | RepositoryBranchesErrorResponse

export interface RepositoryBranchesMessageTransport {
  send(message: RepositoryBranchesMessage): Promise<unknown>
}

export function createRepositoryBranchesMessageHandler(
  loadRepositoryBranches: RepositoryBranchesLoader,
): (message: unknown) => Promise<RepositoryBranchesResponse> | undefined {
  const activeRequests = new Map<string, AbortController>()

  return (message) => {
    if (isCancelMessage(message)) {
      activeRequests.get(message.requestId)?.abort()
      return undefined
    }

    if (!isListMessage(message)) return undefined

    activeRequests.get(message.requestId)?.abort()
    const abortController = new AbortController()
    activeRequests.set(message.requestId, abortController)

    return handleListRequest(
      loadRepositoryBranches,
      message,
      abortController,
      activeRequests,
    )
  }
}

export function createRepositoryBranchesMessageLoader(
  transport: RepositoryBranchesMessageTransport,
): RepositoryBranchesLoader {
  return async (repository, options = {}) => {
    const requestId = crypto.randomUUID()
    const signal = options.signal

    if (signal?.aborted) throw createAbortError()

    const handleAbort = () => {
      void cancelBranchRequest(transport, requestId)
    }
    signal?.addEventListener("abort", handleAbort, { once: true })

    try {
      const response = await raceWithAbort(
        transport.send({
          type: LIST_REPOSITORY_BRANCHES,
          requestId,
          repository,
        }),
        signal,
      )

      if (
        !isRepositoryBranchesResponse(response) ||
        response.requestId !== requestId
      ) {
        throw new GitHubApiError(
          "invalid-response",
          "The extension returned an invalid branch-list response.",
        )
      }

      if (response.ok) return response.result
      if (response.error.code === "aborted") throw createAbortError()

      throw new GitHubApiError(
        response.error.code,
        response.error.message,
        response.error.status,
        response.error.retryAt ? new Date(response.error.retryAt) : null,
      )
    } catch (error) {
      if (isAbortError(error) || error instanceof GitHubApiError) throw error
      throw new GitHubApiError(
        "network",
        "The Peephole background service could not be reached.",
      )
    } finally {
      signal?.removeEventListener("abort", handleAbort)
    }
  }
}

async function handleListRequest(
  loadRepositoryBranches: RepositoryBranchesLoader,
  message: ListRepositoryBranchesMessage,
  abortController: AbortController,
  activeRequests: Map<string, AbortController>,
): Promise<RepositoryBranchesResponse> {
  try {
    const result = await loadRepositoryBranches(message.repository, {
      signal: abortController.signal,
    })
    return { ok: true, requestId: message.requestId, result }
  } catch (error) {
    return {
      ok: false,
      requestId: message.requestId,
      error: serializeError(error),
    }
  } finally {
    if (activeRequests.get(message.requestId) === abortController) {
      activeRequests.delete(message.requestId)
    }
  }
}

async function cancelBranchRequest(
  transport: RepositoryBranchesMessageTransport,
  requestId: string,
): Promise<void> {
  try {
    await transport.send({ type: CANCEL_REPOSITORY_BRANCHES, requestId })
  } catch {
    // Local cancellation remains authoritative when the background is gone.
  }
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation

  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(createAbortError()), {
        once: true,
      })
    }),
  ])
}

function isListMessage(value: unknown): value is ListRepositoryBranchesMessage {
  return (
    isObject(value) &&
    value.type === LIST_REPOSITORY_BRANCHES &&
    isRequestId(value.requestId) &&
    isRepositoryIdentity(value.repository)
  )
}

function isCancelMessage(
  value: unknown,
): value is CancelRepositoryBranchesMessage {
  return (
    isObject(value) &&
    value.type === CANCEL_REPOSITORY_BRANCHES &&
    isRequestId(value.requestId)
  )
}

function isRepositoryBranchesResponse(
  value: unknown,
): value is RepositoryBranchesResponse {
  if (
    !isObject(value) ||
    typeof value.ok !== "boolean" ||
    !isRequestId(value.requestId)
  ) {
    return false
  }

  if (value.ok) return isRepositoryBranchList(value.result)

  return (
    isObject(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string" &&
    (typeof value.error.status === "number" || value.error.status === null) &&
    (typeof value.error.retryAt === "string" || value.error.retryAt === null)
  )
}

function isRepositoryBranchList(value: unknown): value is RepositoryBranchList {
  return (
    isObject(value) &&
    isRepositoryBranchName(value.defaultBranch) &&
    Array.isArray(value.branches) &&
    value.branches.length > 0 &&
    value.branches.length <= MAX_REPOSITORY_BRANCHES &&
    value.branches.every(isRepositoryBranchName) &&
    new Set(value.branches).size === value.branches.length &&
    value.branches.includes(value.defaultBranch) &&
    typeof value.truncated === "boolean"
  )
}

function serializeError(
  error: unknown,
): RepositoryBranchesErrorResponse["error"] {
  if (isAbortError(error)) {
    return {
      code: "aborted",
      message: "Repository branch request was cancelled.",
      status: null,
      retryAt: null,
    }
  }

  if (error instanceof GitHubApiError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      retryAt: error.retryAt?.toISOString() ?? null,
    }
  }

  return {
    code: "unavailable",
    message: "Repository branches could not be loaded.",
    status: null,
    retryAt: null,
  }
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f\d-]{16,64}$/i.test(value)
}

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError")
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
