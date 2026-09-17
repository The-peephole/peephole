import type {
  BuildTargetAnalysis,
  BuildTargetAnalysisLoader,
} from "../../types/analysis"
import type { RepositoryMetadata } from "../../types/repository"
import type { PreviewTarget } from "../../types/target"
import { GitHubApiError, type GitHubApiErrorCode } from "../github/client"
import { isRepositoryIdentity } from "../github/repositoryRef"
import { isSafePreviewSourceRoot } from "../preview/sourceRoot"

export const LOAD_BUILD_TARGET_ANALYSIS =
  "peephole:github:load-build-target-analysis"
export const CANCEL_BUILD_TARGET_ANALYSIS =
  "peephole:github:cancel-build-target-analysis"

type BuildTargetAnalysisMessage =
  | {
      type: typeof LOAD_BUILD_TARGET_ANALYSIS
      requestId: string
      repository: RepositoryMetadata
      target: PreviewTarget
    }
  | { type: typeof CANCEL_BUILD_TARGET_ANALYSIS; requestId: string }

type BuildTargetAnalysisResponse =
  | {
      ok: true
      requestId: string
      analysis: BuildTargetAnalysis
    }
  | {
      ok: false
      requestId: string
      error: {
        code: GitHubApiErrorCode | "aborted"
        message: string
        status: number | null
        retryAt: string | null
      }
    }

export interface BuildTargetAnalysisMessageTransport {
  send(message: BuildTargetAnalysisMessage): Promise<unknown>
}

export function createBuildTargetAnalysisMessageHandler(
  load: BuildTargetAnalysisLoader,
): (message: unknown) => Promise<BuildTargetAnalysisResponse> | undefined {
  const activeRequests = new Map<string, AbortController>()

  return (message) => {
    if (isCancelMessage(message)) {
      activeRequests.get(message.requestId)?.abort()
      return undefined
    }
    if (!isLoadMessage(message)) return undefined

    const abortController = new AbortController()
    activeRequests.set(message.requestId, abortController)
    return handleLoad(load, message, abortController, activeRequests)
  }
}

export function createBuildTargetAnalysisMessageLoader(
  transport: BuildTargetAnalysisMessageTransport,
): BuildTargetAnalysisLoader {
  return async (repository, target, options = {}) => {
    const requestId = crypto.randomUUID()
    const signal = options.signal
    if (signal?.aborted) throw createAbortError()

    const handleAbort = () => {
      void transport
        .send({ type: CANCEL_BUILD_TARGET_ANALYSIS, requestId })
        .catch(() => undefined)
    }
    signal?.addEventListener("abort", handleAbort, { once: true })

    try {
      const response = await raceWithAbort(
        transport.send({
          type: LOAD_BUILD_TARGET_ANALYSIS,
          requestId,
          repository,
          target,
        }),
        signal,
      )

      if (
        !isResponse(response) ||
        response.requestId !== requestId ||
        (response.ok &&
          (!sameRepository(response.analysis.repository, repository) ||
            response.analysis.target.sourceRoot !== target.sourceRoot))
      ) {
        throw new GitHubApiError(
          "invalid-response",
          "The extension returned an invalid target analysis response.",
        )
      }
      if (response.ok) return response.analysis
      if (response.error.code === "aborted") throw createAbortError()

      throw new GitHubApiError(
        response.error.code,
        response.error.message,
        response.error.status,
        response.error.retryAt ? new Date(response.error.retryAt) : null,
      )
    } finally {
      signal?.removeEventListener("abort", handleAbort)
    }
  }
}

async function handleLoad(
  load: BuildTargetAnalysisLoader,
  message: Extract<
    BuildTargetAnalysisMessage,
    { type: typeof LOAD_BUILD_TARGET_ANALYSIS }
  >,
  abortController: AbortController,
  activeRequests: Map<string, AbortController>,
): Promise<BuildTargetAnalysisResponse> {
  try {
    return {
      ok: true,
      requestId: message.requestId,
      analysis: await load(message.repository, message.target, {
        signal: abortController.signal,
      }),
    }
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

function isLoadMessage(
  value: unknown,
): value is Extract<
  BuildTargetAnalysisMessage,
  { type: typeof LOAD_BUILD_TARGET_ANALYSIS }
> {
  return (
    isObject(value) &&
    value.type === LOAD_BUILD_TARGET_ANALYSIS &&
    isRequestId(value.requestId) &&
    isRepositoryMetadata(value.repository) &&
    isPreviewTarget(value.target)
  )
}

function isCancelMessage(
  value: unknown,
): value is Extract<
  BuildTargetAnalysisMessage,
  { type: typeof CANCEL_BUILD_TARGET_ANALYSIS }
> {
  return (
    isObject(value) &&
    value.type === CANCEL_BUILD_TARGET_ANALYSIS &&
    isRequestId(value.requestId)
  )
}

function isResponse(value: unknown): value is BuildTargetAnalysisResponse {
  if (
    !isObject(value) ||
    typeof value.ok !== "boolean" ||
    !isRequestId(value.requestId)
  ) {
    return false
  }
  if (value.ok) {
    return (
      isObject(value.analysis) &&
      isRepositoryMetadata(value.analysis.repository) &&
      isPreviewTarget(value.analysis.target) &&
      isObject(value.analysis.technologies) &&
      isObject(value.analysis.runtime) &&
      isObject(value.analysis.preview) &&
      Array.isArray(value.analysis.preview.blockers) &&
      Array.isArray(value.analysis.inspectedFiles)
    )
  }
  return (
    isObject(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string"
  )
}

function isRepositoryMetadata(value: unknown): value is RepositoryMetadata {
  return (
    isObject(value) &&
    isRepositoryIdentity(value) &&
    Number.isSafeInteger(value.repositoryId) &&
    typeof value.defaultBranch === "string" &&
    /^[a-f\d]{40}$/i.test(String(value.commitSha)) &&
    (typeof value.homepage === "string" || value.homepage === null)
  )
}

function isPreviewTarget(value: unknown): value is PreviewTarget {
  return (
    isObject(value) &&
    Object.keys(value).length === 1 &&
    isSafePreviewSourceRoot(value.sourceRoot)
  )
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f\d-]{16,64}$/i.test(value)
}

function serializeError(
  error: unknown,
): Extract<BuildTargetAnalysisResponse, { ok: false }>["error"] {
  if (isAbortError(error)) {
    return {
      code: "aborted",
      message: "Build target analysis request was cancelled.",
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
    message: "Build target analysis could not be completed.",
    status: null,
    retryAt: null,
  }
}

function raceWithAbort<T>(
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

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError")
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sameRepository(
  left: RepositoryMetadata,
  right: RepositoryMetadata,
): boolean {
  return (
    left.repositoryId === right.repositoryId &&
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase() &&
    left.commitSha.toLowerCase() === right.commitSha.toLowerCase()
  )
}
