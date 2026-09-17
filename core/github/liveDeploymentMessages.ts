import type {
  LiveDeploymentCandidate,
  RepositoryLiveDeployment,
  RepositoryLiveDeploymentLoader,
} from "../../types/deployment"
import type { RepositoryIdentity } from "../../types/repository"
import { GitHubApiError, type GitHubApiErrorCode } from "./client"
import { isRepositoryIdentity } from "./repositoryRef"

export const LOAD_REPOSITORY_DEPLOYMENTS =
  "peephole:github:load-repository-deployments"
export const CANCEL_REPOSITORY_DEPLOYMENTS =
  "peephole:github:cancel-repository-deployments"

interface LoadRepositoryDeploymentsMessage {
  type: typeof LOAD_REPOSITORY_DEPLOYMENTS
  requestId: string
  repository: RepositoryIdentity
}

interface CancelRepositoryDeploymentsMessage {
  type: typeof CANCEL_REPOSITORY_DEPLOYMENTS
  requestId: string
}

type RepositoryDeploymentsMessage =
  LoadRepositoryDeploymentsMessage | CancelRepositoryDeploymentsMessage

interface RepositoryDeploymentsSuccessResponse {
  ok: true
  requestId: string
  result: RepositoryLiveDeployment
}

interface RepositoryDeploymentsErrorResponse {
  ok: false
  requestId: string
  error: {
    code: GitHubApiErrorCode | "aborted"
    message: string
    status: number | null
    retryAt: string | null
  }
}

type RepositoryDeploymentsResponse =
  RepositoryDeploymentsSuccessResponse | RepositoryDeploymentsErrorResponse

export interface RepositoryDeploymentsMessageTransport {
  send(message: RepositoryDeploymentsMessage): Promise<unknown>
}

/**
 * Bounded, fixed background message for GitHub Deployments discovery. This
 * intentionally mirrors `core/github/branchMessages.ts` rather than
 * introducing a generic fetch/proxy primitive: the Side Panel only ever
 * requests "this repository's live deployment state," never an arbitrary
 * URL or GitHub API path.
 */
export function createLiveDeploymentMessageHandler(
  loadRepositoryLiveDeployment: RepositoryLiveDeploymentLoader,
): (message: unknown) => Promise<RepositoryDeploymentsResponse> | undefined {
  const activeRequests = new Map<string, AbortController>()

  return (message) => {
    if (isCancelMessage(message)) {
      activeRequests.get(message.requestId)?.abort()
      return undefined
    }

    if (!isLoadMessage(message)) return undefined

    activeRequests.get(message.requestId)?.abort()
    const abortController = new AbortController()
    activeRequests.set(message.requestId, abortController)

    return handleLoadRequest(
      loadRepositoryLiveDeployment,
      message,
      abortController,
      activeRequests,
    )
  }
}

export function createLiveDeploymentMessageLoader(
  transport: RepositoryDeploymentsMessageTransport,
): RepositoryLiveDeploymentLoader {
  return async (repository, options = {}) => {
    const requestId = crypto.randomUUID()
    const signal = options.signal

    if (signal?.aborted) throw createAbortError()

    const handleAbort = () => {
      void cancelDeploymentsRequest(transport, requestId)
    }
    signal?.addEventListener("abort", handleAbort, { once: true })

    try {
      const response = await raceWithAbort(
        transport.send({
          type: LOAD_REPOSITORY_DEPLOYMENTS,
          requestId,
          repository,
        }),
        signal,
      )

      if (
        !isRepositoryDeploymentsResponse(response) ||
        response.requestId !== requestId
      ) {
        throw new GitHubApiError(
          "invalid-response",
          "The extension returned an invalid deployment response.",
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

async function handleLoadRequest(
  loadRepositoryLiveDeployment: RepositoryLiveDeploymentLoader,
  message: LoadRepositoryDeploymentsMessage,
  abortController: AbortController,
  activeRequests: Map<string, AbortController>,
): Promise<RepositoryDeploymentsResponse> {
  try {
    const result = await loadRepositoryLiveDeployment(message.repository, {
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

async function cancelDeploymentsRequest(
  transport: RepositoryDeploymentsMessageTransport,
  requestId: string,
): Promise<void> {
  try {
    await transport.send({ type: CANCEL_REPOSITORY_DEPLOYMENTS, requestId })
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

function isLoadMessage(
  value: unknown,
): value is LoadRepositoryDeploymentsMessage {
  return (
    isObject(value) &&
    value.type === LOAD_REPOSITORY_DEPLOYMENTS &&
    isRequestId(value.requestId) &&
    isRepositoryIdentity(value.repository)
  )
}

function isCancelMessage(
  value: unknown,
): value is CancelRepositoryDeploymentsMessage {
  return (
    isObject(value) &&
    value.type === CANCEL_REPOSITORY_DEPLOYMENTS &&
    isRequestId(value.requestId)
  )
}

function isRepositoryDeploymentsResponse(
  value: unknown,
): value is RepositoryDeploymentsResponse {
  if (
    !isObject(value) ||
    typeof value.ok !== "boolean" ||
    !isRequestId(value.requestId)
  ) {
    return false
  }

  if (value.ok) return isRepositoryLiveDeployment(value.result)

  return (
    isObject(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string" &&
    (typeof value.error.status === "number" || value.error.status === null) &&
    (typeof value.error.retryAt === "string" || value.error.retryAt === null)
  )
}

function isRepositoryLiveDeployment(
  value: unknown,
): value is RepositoryLiveDeployment {
  if (
    !isObject(value) ||
    (value.status !== "confirmed" && value.status !== "not-detected") ||
    !Number.isInteger(value.candidateCount) ||
    (value.candidateCount as number) < 0 ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.evidence) ||
    !value.evidence.every((entry: unknown) => typeof entry === "string")
  ) {
    return false
  }

  if (value.status === "confirmed")
    return isLiveDeploymentCandidate(value.candidate)
  return value.candidate === null
}

function isLiveDeploymentCandidate(
  value: unknown,
): value is LiveDeploymentCandidate {
  return (
    isObject(value) &&
    typeof value.environment === "string" &&
    typeof value.productionEnvironment === "boolean" &&
    typeof value.url === "string" &&
    (value.ref === null || typeof value.ref === "string") &&
    (value.sha === null || typeof value.sha === "string") &&
    typeof value.state === "string"
  )
}

function serializeError(
  error: unknown,
): RepositoryDeploymentsErrorResponse["error"] {
  if (isAbortError(error)) {
    return {
      code: "aborted",
      message: "Repository deployment request was cancelled.",
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
    message: "Deployment information is currently unavailable.",
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
