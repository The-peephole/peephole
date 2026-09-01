import type {
  RepositoryIdentity,
  RepositoryMetadata,
  RepositoryMetadataLoader,
} from "../../types/repository"
import { GitHubApiError, type GitHubApiErrorCode } from "./client"

export const LOAD_REPOSITORY_METADATA =
  "peephole:github:load-repository-metadata"
export const CANCEL_REPOSITORY_METADATA =
  "peephole:github:cancel-repository-metadata"

interface LoadRepositoryMetadataMessage {
  type: typeof LOAD_REPOSITORY_METADATA
  requestId: string
  repository: RepositoryIdentity
}

interface CancelRepositoryMetadataMessage {
  type: typeof CANCEL_REPOSITORY_METADATA
  requestId: string
}

export type RepositoryMetadataMessage =
  LoadRepositoryMetadataMessage | CancelRepositoryMetadataMessage

interface RepositoryMetadataSuccessResponse {
  ok: true
  requestId: string
  metadata: RepositoryMetadata
}

interface RepositoryMetadataErrorResponse {
  ok: false
  requestId: string
  error: {
    code: GitHubApiErrorCode | "aborted"
    message: string
    status: number | null
    retryAt: string | null
  }
}

export type RepositoryMetadataResponse =
  RepositoryMetadataSuccessResponse | RepositoryMetadataErrorResponse

export type RepositoryMetadataMessageHandler = (
  message: unknown,
) => Promise<RepositoryMetadataResponse> | undefined

export function createRepositoryMetadataMessageHandler(
  loadRepositoryMetadata: RepositoryMetadataLoader,
): RepositoryMetadataMessageHandler {
  const activeRequests = new Map<string, AbortController>()

  return (message) => {
    if (isCancelMessage(message)) {
      activeRequests.get(message.requestId)?.abort()
      return undefined
    }

    if (!isLoadMessage(message)) {
      return undefined
    }

    activeRequests.get(message.requestId)?.abort()
    const abortController = new AbortController()
    activeRequests.set(message.requestId, abortController)

    return loadRepositoryMetadata(message.repository, {
      signal: abortController.signal,
    })
      .then<RepositoryMetadataResponse>((metadata) => ({
        ok: true,
        requestId: message.requestId,
        metadata,
      }))
      .catch<RepositoryMetadataResponse>((error: unknown) => ({
        ok: false,
        requestId: message.requestId,
        error: serializeError(error),
      }))
      .finally(() => {
        if (activeRequests.get(message.requestId) === abortController) {
          activeRequests.delete(message.requestId)
        }
      })
  }
}

export interface RepositoryMetadataMessageTransport {
  send(message: RepositoryMetadataMessage): Promise<unknown>
}

export function createRepositoryMetadataMessageLoader(
  transport: RepositoryMetadataMessageTransport,
): RepositoryMetadataLoader {
  return (repository, options = {}) => {
    const requestId = crypto.randomUUID()
    const signal = options.signal

    if (signal?.aborted) {
      return Promise.reject(createAbortError())
    }

    return new Promise<RepositoryMetadata>((resolve, reject) => {
      let settled = false

      const cleanup = () => signal?.removeEventListener("abort", handleAbort)
      const settle = (callback: () => void) => {
        if (settled) {
          return
        }

        settled = true
        cleanup()
        callback()
      }
      const handleAbort = () => {
        void transport
          .send({ type: CANCEL_REPOSITORY_METADATA, requestId })
          .catch(() => undefined)
        settle(() => reject(createAbortError()))
      }

      signal?.addEventListener("abort", handleAbort, { once: true })

      void transport
        .send({ type: LOAD_REPOSITORY_METADATA, requestId, repository })
        .then(
          (response) => {
            settle(() => {
              if (
                !isRepositoryMetadataResponse(response) ||
                response.requestId !== requestId
              ) {
                reject(
                  new GitHubApiError(
                    "invalid-response",
                    "The extension returned an invalid GitHub response.",
                  ),
                )
                return
              }

              if (response.ok) {
                resolve(response.metadata)
                return
              }

              if (response.error.code === "aborted") {
                reject(createAbortError())
                return
              }

              reject(
                new GitHubApiError(
                  response.error.code,
                  response.error.message,
                  response.error.status,
                  response.error.retryAt
                    ? new Date(response.error.retryAt)
                    : null,
                ),
              )
            })
          },
          () => {
            settle(() =>
              reject(
                new GitHubApiError(
                  "network",
                  "The Peephole background service could not be reached.",
                ),
              ),
            )
          },
        )
    })
  }
}

function isLoadMessage(value: unknown): value is LoadRepositoryMetadataMessage {
  return (
    isObject(value) &&
    value.type === LOAD_REPOSITORY_METADATA &&
    isRequestId(value.requestId) &&
    isRepositoryIdentity(value.repository)
  )
}

function isCancelMessage(
  value: unknown,
): value is CancelRepositoryMetadataMessage {
  return (
    isObject(value) &&
    value.type === CANCEL_REPOSITORY_METADATA &&
    isRequestId(value.requestId)
  )
}

function isRepositoryMetadataResponse(
  value: unknown,
): value is RepositoryMetadataResponse {
  if (
    !isObject(value) ||
    typeof value.ok !== "boolean" ||
    !isRequestId(value.requestId)
  ) {
    return false
  }

  if (value.ok) {
    return isRepositoryMetadata(value.metadata)
  }

  return (
    isObject(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string" &&
    (typeof value.error.status === "number" || value.error.status === null) &&
    (typeof value.error.retryAt === "string" || value.error.retryAt === null)
  )
}

function isRepositoryMetadata(value: unknown): value is RepositoryMetadata {
  if (!isObject(value) || !isRepositoryIdentity(value)) {
    return false
  }

  const metadata = value as unknown as Record<string, unknown>

  return (
    Number.isInteger(metadata.repositoryId) &&
    typeof metadata.defaultBranch === "string" &&
    /^[a-f\d]{40}$/i.test(String(metadata.commitSha)) &&
    (typeof metadata.homepage === "string" || metadata.homepage === null)
  )
}

function isRepositoryIdentity(value: unknown): value is RepositoryIdentity {
  if (!isObject(value)) {
    return false
  }

  return (
    typeof value.owner === "string" &&
    /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value.owner) &&
    typeof value.repo === "string" &&
    /^[a-z\d_.-]+$/i.test(value.repo)
  )
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f\d-]{16,64}$/i.test(value)
}

function serializeError(
  error: unknown,
): RepositoryMetadataErrorResponse["error"] {
  if (isAbortError(error)) {
    return {
      code: "aborted",
      message: "Repository metadata request was cancelled.",
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
    message: "Repository metadata could not be loaded.",
    status: null,
    retryAt: null,
  }
}

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError")
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
