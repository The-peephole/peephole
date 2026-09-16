import type {
  RepositoryAnalysis,
  RepositoryAnalysisLoader,
} from "../../types/analysis"
import type { RepositoryRevisionTarget } from "../../types/repository"
import { GitHubApiError, type GitHubApiErrorCode } from "../github/client"
import {
  isRepositoryIdentity,
  isRepositoryRevisionTarget,
} from "../github/repositoryRef"

export const LOAD_REPOSITORY_ANALYSIS =
  "peephole:github:load-repository-analysis"
export const CANCEL_REPOSITORY_ANALYSIS =
  "peephole:github:cancel-repository-analysis"

interface LoadRepositoryAnalysisMessage {
  type: typeof LOAD_REPOSITORY_ANALYSIS
  requestId: string
  target: RepositoryRevisionTarget
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

    return handleLoadRequest(
      loadRepositoryAnalysis,
      message,
      abortController,
      activeRequests,
    )
  }
}

export interface RepositoryAnalysisMessageTransport {
  send(message: RepositoryAnalysisMessage): Promise<unknown>
}

export function createRepositoryAnalysisMessageLoader(
  transport: RepositoryAnalysisMessageTransport,
): RepositoryAnalysisLoader {
  return async (target, options = {}) => {
    const requestId = crypto.randomUUID()
    const signal = options.signal

    if (signal?.aborted) {
      throw createAbortError()
    }

    const handleAbort = () => {
      void cancelAnalysisRequest(transport, requestId)
    }
    signal?.addEventListener("abort", handleAbort, { once: true })

    try {
      const response = await raceWithAbort(
        transport.send({
          type: LOAD_REPOSITORY_ANALYSIS,
          requestId,
          target,
        }),
        signal,
      )

      if (
        !isRepositoryAnalysisResponse(response) ||
        response.requestId !== requestId
      ) {
        throw new GitHubApiError(
          "invalid-response",
          "The extension returned an invalid analysis response.",
        )
      }

      if (response.ok) {
        return response.analysis
      }

      if (response.error.code === "aborted") {
        throw createAbortError()
      }

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

async function handleLoadRequest(
  loadRepositoryAnalysis: RepositoryAnalysisLoader,
  message: LoadRepositoryAnalysisMessage,
  abortController: AbortController,
  activeRequests: Map<string, AbortController>,
): Promise<RepositoryAnalysisResponse> {
  try {
    const analysis = await loadRepositoryAnalysis(message.target, {
      signal: abortController.signal,
    })
    return { ok: true, requestId: message.requestId, analysis }
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

async function cancelAnalysisRequest(
  transport: RepositoryAnalysisMessageTransport,
  requestId: string,
): Promise<void> {
  try {
    await transport.send({ type: CANCEL_REPOSITORY_ANALYSIS, requestId })
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

function isLoadMessage(value: unknown): value is LoadRepositoryAnalysisMessage {
  return (
    isObject(value) &&
    value.type === LOAD_REPOSITORY_ANALYSIS &&
    isRequestId(value.requestId) &&
    isRepositoryRevisionTarget(value.target)
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
