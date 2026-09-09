import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react"

import { PreviewApiError, type PreviewApi } from "../core/preview/apiClient"
import { createBuildPlanFromAnalysis } from "../core/preview/buildPlan"
import { isTrustedPreviewArtifactUrl } from "../core/preview/config"
import {
  clearStoredPreviewSession,
  getStoredPreviewSession,
  type StoredPreviewSession,
} from "../core/preview/sessionStorage"
import type { RepositoryAnalysis } from "../types/analysis"
import type { CreatePreviewJobRequest, PreviewJob } from "../types/preview"

const TERMINAL_STATUSES = new Set(["ready", "failed", "cancelled", "expired"])
const SESSION_EXPIRY_SKEW_MS = 5_000

type AuthenticationStatus = "checking" | "authenticated" | "unauthenticated"

type PreviewUiState =
  | { status: "idle" }
  | { status: "creating" }
  | { status: "job"; job: PreviewJob }
  | { status: "cancelling"; job: PreviewJob }
  | { status: "authenticating" }
  | {
      status: "error"
      message: string
      requiresAuthentication: boolean
      job?: PreviewJob
    }

interface PreviewJobPanelProps {
  analysis: RepositoryAnalysis
  previewApi: PreviewApi | null
  previewArtifactBaseDomain?: string | null
  configurationError?: string | null
  connectGitHub?: (() => Promise<void>) | null
  getSession?: () => Promise<StoredPreviewSession | null>
  clearSession?: () => Promise<void>
  pollIntervalMs?: number
}

export function PreviewJobPanel({
  analysis,
  previewApi,
  configurationError = null,
  connectGitHub = null,
  getSession = getStoredPreviewSession,
  clearSession = clearStoredPreviewSession,
  previewArtifactBaseDomain = null,
  pollIntervalMs = 1_500,
}: PreviewJobPanelProps) {
  const [state, setState] = useState<PreviewUiState>({ status: "idle" })
  const [authenticationStatus, setAuthenticationStatus] =
    useState<AuthenticationStatus>("checking")
  const activeRequest = useRef<AbortController | null>(null)
  const createKey = useRef<string | null>(null)
  const request = createRequest(analysis)
  const repositoryKey = `${analysis.repository.repositoryId}:${analysis.repository.commitSha}`

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
    createKey.current = null
    setState({ status: "idle" })

    return () => activeRequest.current?.abort()
  }, [repositoryKey])

  useEffect(() => {
    if (
      !previewApi ||
      state.status !== "job" ||
      TERMINAL_STATUSES.has(state.job.status)
    ) {
      return
    }

    const abortController = new AbortController()
    const timeout = window.setTimeout(() => {
      void previewApi
        .get(state.job.id, { signal: abortController.signal })
        .then(
          (job) => {
            if (!abortController.signal.aborted)
              setState({ status: "job", job })
          },
          (error: unknown) => {
            if (!abortController.signal.aborted) {
              setState(createErrorState(error, state.job))
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
  }, [pollIntervalMs, previewApi, repositoryKey, state])

  useEffect(() => {
    if (state.status !== "job" || state.job.status !== "ready") return
    const job = state.job
    const expiresAt = Math.min(
      Date.parse(job.expiresAt),
      Date.parse(job.artifact?.expiresAt ?? job.expiresAt),
    )
    let timer: number
    const checkExpiry = () => {
      const remaining = expiresAt - Date.now()
      if (remaining <= 0) {
        setState({
          status: "job",
          job: { ...job, status: "expired", artifact: null },
        })
      } else {
        timer = window.setTimeout(checkExpiry, Math.min(remaining, 60_000))
      }
    }
    checkExpiry()
    return () => window.clearTimeout(timer)
  }, [repositoryKey, state])

  if (!request) {
    return null
  }

  if (!previewApi) {
    return (
      <section className="peephole__preview-action">
        <button className="peephole__primary" disabled type="button">
          Build preview
        </button>
        <p className="peephole__action-note">
          {configurationError ??
            "Preview service not configured. Set WXT_PREVIEW_API_BASE_URL before building the extension."}
        </p>
      </section>
    )
  }

  if (authenticationStatus === "checking") {
    return <JobProgress label="Checking GitHub connection..." />
  }

  if (authenticationStatus === "unauthenticated") {
    if (state.status === "authenticating") {
      return <JobProgress label="Connecting GitHub..." />
    }

    return (
      <section className="peephole__preview-action">
        <button
          className="peephole__primary"
          disabled={!connectGitHub}
          onClick={() => {
            if (!connectGitHub) return
            const pendingError =
              state.status === "error" && state.requiresAuthentication
                ? state
                : null
            setState({ status: "authenticating" })
            void connectGitHub().then(
              () => {
                setAuthenticationStatus("authenticated")
                if (pendingError?.job) {
                  setState({ status: "job", job: pendingError.job })
                } else if (pendingError) {
                  startPreview(
                    previewApi,
                    request,
                    activeRequest,
                    setState,
                    createKey,
                    setAuthenticationStatus,
                  )
                } else {
                  setState({ status: "idle" })
                }
              },
              (error: unknown) =>
                setState(createErrorState(error, undefined, true)),
            )
          }}
          type="button"
        >
          Connect GitHub
        </button>
        <p className="peephole__action-note">
          {state.status === "error" && state.requiresAuthentication
            ? state.message
            : "Connect GitHub before building a preview."}
        </p>
      </section>
    )
  }

  if (state.status === "idle") {
    return (
      <section className="peephole__preview-action">
        <button
          className="peephole__primary"
          onClick={() =>
            startPreview(
              previewApi,
              request,
              activeRequest,
              setState,
              createKey,
              setAuthenticationStatus,
            )
          }
          type="button"
        >
          Build preview
        </button>
        <p className="peephole__action-note">
          Builds a preview of this exact commit.
        </p>
      </section>
    )
  }

  if (state.status === "creating") {
    return <JobProgress label="Creating preview job..." />
  }

  if (state.status === "authenticating") {
    return <JobProgress label="Connecting GitHub..." />
  }

  if (state.status === "error") {
    return (
      <section className="peephole__job peephole__job--error" role="alert">
        <strong>Preview request failed</strong>
        <p>{state.message}</p>
        <button
          className="peephole__secondary"
          onClick={() => {
            if (state.job) {
              setState({ status: "job", job: state.job })
            } else {
              startPreview(
                previewApi,
                request,
                activeRequest,
                setState,
                createKey,
                setAuthenticationStatus,
              )
            }
          }}
          type="button"
        >
          {state.job ? "Check status" : "Retry"}
        </button>
      </section>
    )
  }

  if (state.status === "cancelling") {
    return <JobProgress label="Cancelling preview..." />
  }

  const { job } = state

  if (job.status === "ready") {
    return (
      <ReadyPreview
        job={job}
        previewArtifactBaseDomain={previewArtifactBaseDomain}
      />
    )
  }

  if (job.status === "failed") {
    return (
      <section className="peephole__job peephole__job--error" role="alert">
        <strong>Preview failed</strong>
        <p>
          {job.errorMessage ?? "The preview worker could not finish the build."}
        </p>
        <button
          className="peephole__secondary"
          onClick={() => {
            createKey.current = null
            setState({ status: "idle" })
          }}
          type="button"
        >
          Build again
        </button>
      </section>
    )
  }

  if (job.status === "cancelled" || job.status === "expired") {
    return (
      <section className="peephole__job" role="status">
        <strong>Preview {job.status}</strong>
        <button
          className="peephole__secondary"
          onClick={() => {
            createKey.current = null
            setState({ status: "idle" })
          }}
          type="button"
        >
          Build again
        </button>
      </section>
    )
  }

  return (
    <section className="peephole__job" role="status">
      <div className="peephole__job-heading">
        <span aria-hidden="true" className="peephole__spinner" />
        <strong>{formatStatus(job.status)}</strong>
      </div>
      <p>Job {job.id}</p>
      <button
        className="peephole__secondary"
        onClick={() =>
          cancelPreview(
            previewApi,
            job,
            activeRequest,
            setState,
            setAuthenticationStatus,
          )
        }
        type="button"
      >
        Cancel
      </button>
    </section>
  )
}

function ReadyPreview({
  job,
  previewArtifactBaseDomain,
}: {
  job: PreviewJob
  previewArtifactBaseDomain: string | null
}) {
  const artifactUrl = job.artifact?.url ?? null
  const trusted =
    artifactUrl !== null &&
    isTrustedPreviewArtifactUrl(artifactUrl, previewArtifactBaseDomain)

  return (
    <section className="peephole__job peephole__job--ready" role="status">
      <strong>Preview ready</strong>
      {trusted && artifactUrl ? (
        <>
          <iframe
            className="peephole__preview-frame"
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-forms"
            src={artifactUrl}
            title="Peephole preview"
          />
          <a
            className="peephole__link"
            href={artifactUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            Open in a new tab
          </a>
        </>
      ) : (
        <p>
          {artifactUrl
            ? "This build's preview origin is not approved for embedding."
            : "The artifact is ready but no preview URL was returned."}
        </p>
      )}
    </section>
  )
}

function JobProgress({ label }: { label: string }) {
  return (
    <section className="peephole__job" role="status">
      <div className="peephole__job-heading">
        <span aria-hidden="true" className="peephole__spinner" />
        <strong>{label}</strong>
      </div>
    </section>
  )
}

function createRequest(
  analysis: RepositoryAnalysis,
): CreatePreviewJobRequest | null {
  if (analysis.preview.mode !== "native-static-build") {
    return null
  }

  const plan = createBuildPlanFromAnalysis(analysis)

  return plan
    ? { repository: plan.repository, contractVersion: plan.contractVersion }
    : null
}

function startPreview(
  previewApi: PreviewApi,
  request: CreatePreviewJobRequest,
  activeRequest: MutableRefObject<AbortController | null>,
  setState: Dispatch<SetStateAction<PreviewUiState>>,
  createKey: MutableRefObject<string | null>,
  setAuthenticationStatus: Dispatch<SetStateAction<AuthenticationStatus>>,
): void {
  activeRequest.current?.abort()
  const abortController = new AbortController()
  activeRequest.current = abortController
  setState({ status: "creating" })

  createKey.current ??= `preview-${crypto.randomUUID()}`
  void previewApi
    .create(request, {
      signal: abortController.signal,
      idempotencyKey: createKey.current,
    })
    .then(
      (job) => {
        if (!abortController.signal.aborted) setState({ status: "job", job })
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

function cancelPreview(
  previewApi: PreviewApi,
  job: PreviewJob,
  activeRequest: MutableRefObject<AbortController | null>,
  setState: Dispatch<SetStateAction<PreviewUiState>>,
  setAuthenticationStatus: Dispatch<SetStateAction<AuthenticationStatus>>,
): void {
  activeRequest.current?.abort()
  const abortController = new AbortController()
  activeRequest.current = abortController
  setState({ status: "cancelling", job })

  void previewApi.cancel(job.id, { signal: abortController.signal }).then(
    (cancelled) => {
      if (!abortController.signal.aborted) {
        setState({ status: "job", job: cancelled })
      }
    },
    (error: unknown) => {
      if (!abortController.signal.aborted) {
        setState(createErrorState(error, job))
        if (isAuthenticationError(error)) {
          setAuthenticationStatus("unauthenticated")
        }
      }
    },
  )
}

function formatStatus(status: PreviewJob["status"]): string {
  return {
    queued: "Queued",
    fetching: "Fetching repository",
    installing: "Installing dependencies",
    building: "Building preview",
    publishing: "Publishing preview",
    ready: "Preview ready",
    failed: "Preview failed",
    cancelled: "Preview cancelled",
    expired: "Preview expired",
  }[status]
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The preview service could not complete the request."
}

function isAuthenticationError(error: unknown): boolean {
  return error instanceof PreviewApiError && error.code === "UNAUTHORIZED"
}

function createErrorState(
  error: unknown,
  job?: PreviewJob,
  requiresAuthentication = isAuthenticationError(error),
): Extract<PreviewUiState, { status: "error" }> {
  return {
    status: "error",
    message: safeErrorMessage(error),
    requiresAuthentication,
    ...(job ? { job } : {}),
  }
}
