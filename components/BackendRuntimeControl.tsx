import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react"

import {
  BackendRuntimeApiError,
  type BackendRuntimeApi,
} from "../core/backendRuntime/apiClient"
import {
  clearStoredPreviewSession,
  getStoredPreviewSession,
  type StoredPreviewSession,
} from "../core/preview/sessionStorage"
import type { BackendCandidate } from "../types/backend"
import type { BackendRuntime } from "../types/backendRuntime"
import type { PreviewRepositoryRef } from "../types/preview"
import type { RepositoryMetadata } from "../types/repository"

const TERMINAL_STATUSES = new Set<BackendRuntime["status"]>([
  "stopped",
  "failed",
  "cancelled",
  "expired",
])
const SESSION_EXPIRY_SKEW_MS = 5_000

type AuthenticationStatus = "checking" | "authenticated" | "unauthenticated"

type BackendRuntimeUiState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "runtime"; runtime: BackendRuntime }
  | { status: "stopping"; runtime: BackendRuntime }
  | { status: "authenticating" }
  | {
      status: "error"
      message: string
      requiresAuthentication: boolean
      runtime?: BackendRuntime
    }

export interface BackendRuntimeControlProps {
  candidate: BackendCandidate
  repository: RepositoryMetadata
  backendRuntimeApi: BackendRuntimeApi | null
  connectGitHub?: (() => Promise<void>) | null
  getSession?: () => Promise<StoredPreviewSession | null>
  clearSession?: () => Promise<void>
  pollIntervalMs?: number
}

/**
 * Never shows a URL, never adds a preview-target option, and never connects
 * a frontend to this backend -- see docs/PREVIEW_RUNTIME.md's "Backend
 * Runtime (backend-v1)". Mirrors `PreviewJobPanel`'s auth/poll/error
 * handling shape but talks to the wholly separate `/v1/backend-runtimes`
 * resource through `BackendRuntimeApiClient`.
 */
export function BackendRuntimeControl({
  candidate,
  repository,
  backendRuntimeApi,
  connectGitHub = null,
  getSession = getStoredPreviewSession,
  clearSession = clearStoredPreviewSession,
  pollIntervalMs = 2_000,
}: BackendRuntimeControlProps) {
  const [state, setState] = useState<BackendRuntimeUiState>({ status: "idle" })
  const [authenticationStatus, setAuthenticationStatus] =
    useState<AuthenticationStatus>("checking")
  const activeRequest = useRef<AbortController | null>(null)
  const repositoryRef: PreviewRepositoryRef = {
    repositoryId: repository.repositoryId,
    owner: repository.owner,
    name: repository.repo,
    commitSha: repository.commitSha,
  }
  const repositoryKey = `${repositoryRef.repositoryId}:${repositoryRef.commitSha}:${candidate.sourceRoot}`

  useEffect(() => {
    let active = true

    void getSession().then(
      async (session) => {
        const expiresAt = session ? Date.parse(session.expiresAt) : Number.NaN
        const authenticated =
          Boolean(session?.token) &&
          Number.isFinite(expiresAt) &&
          expiresAt > Date.now() + SESSION_EXPIRY_SKEW_MS

        if (!authenticated) await clearSession().catch(() => undefined)
        if (active) {
          setAuthenticationStatus(
            authenticated ? "authenticated" : "unauthenticated",
          )
        }
      },
      () => {
        if (active) setAuthenticationStatus("unauthenticated")
      },
    )

    return () => {
      active = false
    }
  }, [clearSession, getSession])

  useEffect(() => {
    activeRequest.current?.abort()
    activeRequest.current = null
    setState({ status: "idle" })

    return () => activeRequest.current?.abort()
  }, [repositoryKey])

  useEffect(() => {
    if (
      !backendRuntimeApi ||
      state.status !== "runtime" ||
      TERMINAL_STATUSES.has(state.runtime.status)
    ) {
      return
    }

    const abortController = new AbortController()
    const timeout = window.setTimeout(() => {
      void backendRuntimeApi
        .get(state.runtime.id, { signal: abortController.signal })
        .then(
          (runtime) => {
            if (!abortController.signal.aborted)
              setState({ status: "runtime", runtime })
          },
          (error: unknown) => {
            if (!abortController.signal.aborted) {
              setState(createErrorState(error, state.runtime))
              if (isAuthenticationError(error)) {
                setAuthenticationStatus("unauthenticated")
              }
            }
          },
        )
    }, pollIntervalMs)

    return () => {
      window.clearTimeout(timeout)
      abortController.abort()
    }
  }, [backendRuntimeApi, pollIntervalMs, repositoryKey, state])

  if (!backendRuntimeApi) {
    return null
  }

  if (authenticationStatus === "checking") {
    return <RuntimeProgress label="Checking GitHub connection..." />
  }

  if (authenticationStatus === "unauthenticated") {
    if (state.status === "authenticating") {
      return <RuntimeProgress label="Connecting GitHub..." />
    }

    return (
      <div className="peephole__backend-runtime">
        <button
          className="peephole__secondary"
          disabled={!connectGitHub}
          onClick={() => {
            if (!connectGitHub) return
            setState({ status: "authenticating" })
            void connectGitHub().then(
              () => {
                setAuthenticationStatus("authenticated")
                setState({ status: "idle" })
              },
              (error: unknown) =>
                setState(createErrorState(error, undefined, true)),
            )
          }}
          type="button"
        >
          Connect GitHub
        </button>
      </div>
    )
  }

  if (state.status === "idle") {
    return (
      <div className="peephole__backend-runtime">
        <button
          className="peephole__secondary"
          onClick={() =>
            startBackendRuntime(
              backendRuntimeApi,
              repositoryRef,
              candidate.sourceRoot,
              activeRequest,
              setState,
              setAuthenticationStatus,
            )
          }
          type="button"
        >
          Start backend
        </button>
      </div>
    )
  }

  if (state.status === "starting") {
    return <RuntimeProgress label="Requesting backend runtime..." />
  }

  if (state.status === "authenticating") {
    return <RuntimeProgress label="Connecting GitHub..." />
  }

  if (state.status === "error") {
    return (
      <div className="peephole__backend-runtime" role="alert">
        <p>{state.message}</p>
        <button
          className="peephole__secondary"
          onClick={() => {
            if (state.runtime) {
              setState({ status: "runtime", runtime: state.runtime })
            } else {
              startBackendRuntime(
                backendRuntimeApi,
                repositoryRef,
                candidate.sourceRoot,
                activeRequest,
                setState,
                setAuthenticationStatus,
              )
            }
          }}
          type="button"
        >
          {state.runtime ? "Check status" : "Retry"}
        </button>
      </div>
    )
  }

  if (state.status === "stopping") {
    return <RuntimeProgress label="Stopping backend..." />
  }

  const { runtime } = state

  if (TERMINAL_STATUSES.has(runtime.status)) {
    return (
      <div className="peephole__backend-runtime" role="status">
        <p>Backend runtime: {formatRuntimeStatus(runtime.status)}</p>
        {runtime.status === "failed" && runtime.errorMessage && (
          <p>{runtime.errorMessage}</p>
        )}
        <button
          className="peephole__secondary"
          onClick={() => setState({ status: "idle" })}
          type="button"
        >
          Start backend
        </button>
      </div>
    )
  }

  return (
    <div className="peephole__backend-runtime" role="status">
      <p>Backend runtime: {formatRuntimeStatus(runtime.status)}</p>
      <button
        className="peephole__secondary"
        onClick={() =>
          stopBackendRuntime(
            backendRuntimeApi,
            runtime,
            activeRequest,
            setState,
            setAuthenticationStatus,
          )
        }
        type="button"
      >
        Stop backend
      </button>
    </div>
  )
}

function RuntimeProgress({ label }: { label: string }) {
  return (
    <div className="peephole__backend-runtime" role="status">
      <span aria-hidden="true" className="peephole__spinner" />
      <span>{label}</span>
    </div>
  )
}

function startBackendRuntime(
  backendRuntimeApi: BackendRuntimeApi,
  repository: PreviewRepositoryRef,
  sourceRoot: string,
  activeRequest: MutableRefObject<AbortController | null>,
  setState: Dispatch<SetStateAction<BackendRuntimeUiState>>,
  setAuthenticationStatus: Dispatch<SetStateAction<AuthenticationStatus>>,
): void {
  activeRequest.current?.abort()
  const abortController = new AbortController()
  activeRequest.current = abortController
  setState({ status: "starting" })

  void backendRuntimeApi
    .create(repository, sourceRoot, { signal: abortController.signal })
    .then(
      (runtime) => {
        if (!abortController.signal.aborted) {
          setState({ status: "runtime", runtime })
        }
      },
      (error: unknown) => {
        if (!abortController.signal.aborted) {
          setState(createErrorState(error))
          if (isAuthenticationError(error)) {
            setAuthenticationStatus("unauthenticated")
          }
        }
      },
    )
}

function stopBackendRuntime(
  backendRuntimeApi: BackendRuntimeApi,
  runtime: BackendRuntime,
  activeRequest: MutableRefObject<AbortController | null>,
  setState: Dispatch<SetStateAction<BackendRuntimeUiState>>,
  setAuthenticationStatus: Dispatch<SetStateAction<AuthenticationStatus>>,
): void {
  activeRequest.current?.abort()
  const abortController = new AbortController()
  activeRequest.current = abortController
  setState({ status: "stopping", runtime })

  void backendRuntimeApi
    .cancel(runtime.id, { signal: abortController.signal })
    .then(
      (cancelled) => {
        if (!abortController.signal.aborted) {
          setState({ status: "runtime", runtime: cancelled })
        }
      },
      (error: unknown) => {
        if (!abortController.signal.aborted) {
          setState(createErrorState(error, runtime))
          if (isAuthenticationError(error)) {
            setAuthenticationStatus("unauthenticated")
          }
        }
      },
    )
}

function formatRuntimeStatus(status: BackendRuntime["status"]): string {
  return {
    queued: "Queued",
    fetching: "Fetching repository",
    installing: "Installing dependencies",
    starting: "Starting",
    running: "Running",
    stopping: "Stopping...",
    stopped: "Stopped",
    failed: "Failed",
    cancelled: "Cancelled",
    expired: "Expired",
  }[status]
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The backend runtime service could not complete the request."
}

function isAuthenticationError(error: unknown): boolean {
  return (
    error instanceof BackendRuntimeApiError && error.code === "UNAUTHORIZED"
  )
}

function createErrorState(
  error: unknown,
  runtime?: BackendRuntime,
  requiresAuthentication = isAuthenticationError(error),
): Extract<BackendRuntimeUiState, { status: "error" }> {
  return {
    status: "error",
    message: safeErrorMessage(error),
    requiresAuthentication,
    ...(runtime ? { runtime } : {}),
  }
}
