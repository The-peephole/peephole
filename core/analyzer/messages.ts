import type {
  RepositoryAnalysis,
  RepositoryAnalysisLoader,
} from "../../types/analysis"
import type { RepositoryIdentity } from "../../types/repository"
import { GitHubApiError, type GitHubApiErrorCode } from "../github/client"

export const LOAD_REPOSITORY_ANALYSIS =
  "peephole:github:load-repository-analysis"
export const CANCEL_REPOSITORY_ANALYSIS =
  "peephole:github:cancel-repository-analysis"

interface LoadRepositoryAnalysisMessage {
  type: typeof LOAD_REPOSITORY_ANALYSIS
  requestId: string
  repository: RepositoryIdentity
}

interface CancelRepositoryAnalysisMessage {
  type: typeof CANCEL_REPOSITORY_ANALYSIS
  requestId: string
}

export type RepositoryAnalysisMessage =
  LoadRepositoryAnalysisMessage | CancelRepositoryAnalysisMessage

interface RepositoryAnalysisSuccessResponse {
  ok: true
  requestId: string
  analysis: RepositoryAnalysis
}

interface RepositoryAnalysisErrorResponse {
  ok: false
  requestId: string
  error: {
    code: GitHubApiErrorCode | "aborted"
    message: string
    status: number | null
    retryAt: string | null
  }
}

export type RepositoryAnalysisResponse =
  RepositoryAnalysisSuccessResponse | RepositoryAnalysisErrorResponse

export function createRepositoryAnalysisMessageHandler(
  loadRepositoryAnalysis: RepositoryAnalysisLoader,
): (message: unknown) => Promise<RepositoryAnalysisResponse> | undefined {
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

    return loadRepositoryAnalysis(message.repository, {
      signal: abortController.signal,
    })
      .then<RepositoryAnalysisResponse>((analysis) => ({
        ok: true,
        requestId: message.requestId,
        analysis,
      }))
      .catch<RepositoryAnalysisResponse>((error: unknown) => ({
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

export interface RepositoryAnalysisMessageTransport {
  send(message: RepositoryAnalysisMessage): Promise<unknown>
}

export function createRepositoryAnalysisMessageLoader(
  transport: RepositoryAnalysisMessageTransport,
): RepositoryAnalysisLoader {
  return (repository, options = {}) => {
    const requestId = crypto.randomUUID()
    const signal = options.signal

    if (signal?.aborted) {
      return Promise.reject(createAbortError())
    }

    return new Promise<RepositoryAnalysis>((resolve, reject) => {
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
          .send({ type: CANCEL_REPOSITORY_ANALYSIS, requestId })
          .catch(() => undefined)
        settle(() => reject(createAbortError()))
      }

      signal?.addEventListener("abort", handleAbort, { once: true })

      void transport
        .send({ type: LOAD_REPOSITORY_ANALYSIS, requestId, repository })
        .then(
          (response) => {
            settle(() => {
              if (
                !isRepositoryAnalysisResponse(response) ||
                response.requestId !== requestId
              ) {
                reject(
                  new GitHubApiError(
                    "invalid-response",
                    "The extension returned an invalid analysis response.",
                  ),
                )
                return
              }

              if (response.ok) {
                resolve(response.analysis)
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

function isLoadMessage(value: unknown): value is LoadRepositoryAnalysisMessage {
  return (
    isObject(value) &&
    value.type === LOAD_REPOSITORY_ANALYSIS &&
    isRequestId(value.requestId) &&
    isRepositoryIdentity(value.repository)
  )
}

function isCancelMessage(
  value: unknown,
): value is CancelRepositoryAnalysisMessage {
  return (
    isObject(value) &&
    value.type === CANCEL_REPOSITORY_ANALYSIS &&
    isRequestId(value.requestId)
  )
}

function isRepositoryAnalysisResponse(
  value: unknown,
): value is RepositoryAnalysisResponse {
  if (
    !isObject(value) ||
    typeof value.ok !== "boolean" ||
    !isRequestId(value.requestId)
  ) {
    return false
  }

  if (value.ok) {
    return isRepositoryAnalysis(value.analysis)
  }

  return (
    isObject(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string" &&
    (typeof value.error.status === "number" || value.error.status === null) &&
    (typeof value.error.retryAt === "string" || value.error.retryAt === null)
  )
}

function isRepositoryAnalysis(value: unknown): value is RepositoryAnalysis {
  return (
    isObject(value) &&
    isRepositoryMetadata(value.repository) &&
    typeof value.analyzerVersion === "string" &&
    isObject(value.technologies) &&
    typeof value.technologies.framework === "string" &&
    typeof value.packageManager === "string" &&
    isObject(value.runtime) &&
    isObject(value.environment) &&
    isObject(value.deployment) &&
    isObject(value.workspace) &&
    isObject(value.preview) &&
    typeof value.preview.mode === "string" &&
    Array.isArray(value.preview.blockers) &&
    Array.isArray(value.inspectedFiles) &&
    Array.isArray(value.warnings)
  )
}

function isRepositoryMetadata(value: unknown): boolean {
  return (
    isRepositoryIdentity(value) &&
    isObject(value) &&
    Number.isInteger(value.repositoryId) &&
    typeof value.defaultBranch === "string" &&
    /^[a-f\d]{40}$/i.test(String(value.commitSha)) &&
    (typeof value.homepage === "string" || value.homepage === null)
  )
}

function isRepositoryIdentity(value: unknown): value is RepositoryIdentity {
  return (
    isObject(value) &&
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
): RepositoryAnalysisErrorResponse["error"] {
  if (isAbortError(error)) {
    return {
      code: "aborted",
      message: "Repository analysis request was cancelled.",
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
    message: "Repository analysis could not be completed.",
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
