import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react"

import {
  FullStackPreviewApiError,
  createFullStackPreviewRequest,
  type FullStackPreviewApi,
} from "../core/fullstack/apiClient"
import { isTrustedFullStackPreviewUrl } from "../core/preview/config"
import {
  clearStoredPreviewSession,
  getStoredPreviewSession,
  type StoredPreviewSession,
} from "../core/preview/sessionStorage"
import type { BuildTargetAnalysis, RepositoryAnalysis } from "../types/analysis"
import type { BackendCandidate } from "../types/backend"
import type { FullStackPreview } from "../types/fullstackPreview"

const TERMINAL_STATUSES = new Set<FullStackPreview["status"]>([
  "stopped",
  "failed",
  "cancelled",
  "expired",
])
const SESSION_EXPIRY_SKEW_MS = 5_000

type AuthenticationStatus = "checking" | "authenticated" | "unauthenticated"

type FullStackPreviewUiState =
  | { status: "idle" }
  | { status: "creating" }
  | { status: "preview"; preview: FullStackPreview }
  | { status: "stopping"; preview: FullStackPreview }
  | { status: "authenticating" }
  | {
      status: "error"
      message: string
      requiresAuthentication: boolean
      preview?: FullStackPreview
    }

export interface FullStackPreviewPanelProps {
  analysis: BuildTargetAnalysis & RepositoryAnalysis
  fullStackPreviewApi: FullStackPreviewApi | null
  previewArtifactBaseDomain?: string | null
  configurationError?: string | null
  connectGitHub?: (() => Promise<void>) | null
  getSession?: () => Promise<StoredPreviewSession | null>
  clearSession?: () => Promise<void>
  pollIntervalMs?: number
}

export function FullStackPreviewPanel({
  analysis,
  fullStackPreviewApi,
  previewArtifactBaseDomain = null,
  configurationError = null,
  connectGitHub = null,
  getSession = getStoredPreviewSession,
  clearSession = clearStoredPreviewSession,
  pollIntervalMs = 2_000,
}: FullStackPreviewPanelProps) {
  const candidates = analysis.backend.candidates
  const backendSelectionId = useId()
  const backendSelectionHelpId = useId()
  const [backendSourceRoot, setBackendSourceRoot] = useState(
    candidates.length === 1 &&
      analysis.backend.complete &&
      !analysis.backend.truncated
      ? candidates[0]!.sourceRoot
      : "",
  )
  const [state, setState] = useState<FullStackPreviewUiState>({
    status: "idle",
  })
  const [authenticationStatus, setAuthenticationStatus] =
    useState<AuthenticationStatus>("checking")
  const activeRequest = useRef<AbortController | null>(null)
  const createKey = useRef<string | null>(null)
  const repository = useMemo(
    () => ({
      repositoryId: analysis.repository.repositoryId,
      owner: analysis.repository.owner,
      name: analysis.repository.repo,
      commitSha: analysis.repository.commitSha,
    }),
    [analysis.repository],
  )
  const requestIdentity = `${repository.repositoryId}:${repository.commitSha}:${analysis.target.sourceRoot}:${backendSourceRoot}`
  const selectedBackend = candidates.find(
    (candidate) => candidate.sourceRoot === backendSourceRoot,
  )
  const detectionIsComplete =
    analysis.backend.complete && !analysis.backend.truncated
  const frontendIsEligible = analysis.preview.mode === "native-static-build"

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
  }, [requestIdentity])

  useEffect(() => {
    if (
      !fullStackPreviewApi ||
      state.status !== "preview" ||
      TERMINAL_STATUSES.has(state.preview.status)
    ) {
      return
    }

    const abortController = new AbortController()
    const timeout = window.setTimeout(() => {
      void fullStackPreviewApi
        .get(state.preview.id, { signal: abortController.signal })
        .then(
          (preview) => {
            if (!abortController.signal.aborted) {
              setState({ status: "preview", preview })
            }
          },
          (error: unknown) => {
            if (!abortController.signal.aborted) {
              setState(createErrorState(error, state.preview))
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
  }, [fullStackPreviewApi, pollIntervalMs, requestIdentity, state])

  const start = () => {
    if (!fullStackPreviewApi || !selectedBackend) return
    startFullStackPreview(
      fullStackPreviewApi,
      createFullStackPreviewRequest({
        repository,
        frontendSourceRoot: analysis.target.sourceRoot,
        backendSourceRoot: selectedBackend.sourceRoot,
      }),
      activeRequest,
      setState,
      createKey,
      setAuthenticationStatus,
    )
  }

  return (
    <section
      className="peephole__fullstack"
      aria-labelledby={`${backendSelectionId}-title`}
    >
      <h3 id={`${backendSelectionId}-title`}>Full-stack preview</h3>
      <p className="peephole__action-note">
        Runs a separate fullstack-v1 job for this exact commit. Static Build
        preview remains independent.
      </p>

      {candidates.length > 1 && detectionIsComplete && (
        <div className="peephole__fullstack-target">
          <label
            className="peephole__branch-label"
            htmlFor={backendSelectionId}
          >
            Backend target
          </label>
          <p className="peephole__branch-help" id={backendSelectionHelpId}>
            Select the backend that belongs with{" "}
            {analysis.target.sourceRoot === "."
              ? "the repository root"
              : analysis.target.sourceRoot}
            . The server verifies both targets again.
          </p>
          <select
            aria-describedby={backendSelectionHelpId}
            className="peephole__branch-select"
            id={backendSelectionId}
            name="fullstack-backend-target"
            onChange={(event) =>
              setBackendSourceRoot(event.currentTarget.value)
            }
            value={backendSourceRoot}
          >
            <option value="">Choose a backend</option>
            {candidates.map((candidate) => (
              <option key={candidate.sourceRoot} value={candidate.sourceRoot}>
                {formatCandidate(candidate)}
              </option>
            ))}
          </select>
        </div>
      )}

      {!frontendIsEligible ? (
        <FullStackNotice message="The selected frontend does not qualify for a native build. Full-stack preview is unavailable." />
      ) : !detectionIsComplete ? (
        <FullStackNotice message="Backend detection is incomplete or ambiguous. Re-run analysis before starting a full-stack preview." />
      ) : candidates.length === 0 ? (
        <FullStackNotice message="No backend candidate was detected for this commit." />
      ) : !selectedBackend ? (
        <FullStackNotice message="Choose an explicit backend target to continue." />
      ) : configurationError ? (
        <FullStackNotice message={configurationError} />
      ) : !fullStackPreviewApi ? (
        <FullStackNotice message="Full-stack preview requires WXT_PREVIEW_API_BASE_URL." />
      ) : authenticationStatus === "checking" ? (
        <FullStackProgress label="Checking GitHub connection..." />
      ) : authenticationStatus === "unauthenticated" ? (
        state.status === "authenticating" ? (
          <FullStackProgress label="Connecting GitHub..." />
        ) : (
          <div className="peephole__preview-action">
            <button
              className="peephole__secondary"
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
                    if (pendingError?.preview) {
                      setState({
                        status: "preview",
                        preview: pendingError.preview,
                      })
                    } else if (pendingError) {
                      start()
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
                : "Connect GitHub before running a full-stack preview."}
            </p>
          </div>
        )
      ) : state.status === "idle" ? (
        <button className="peephole__primary" onClick={start} type="button">
          Run full-stack preview
        </button>
      ) : state.status === "creating" ? (
        <FullStackProgress label="Creating full-stack preview..." />
      ) : state.status === "authenticating" ? (
        <FullStackProgress label="Connecting GitHub..." />
      ) : state.status === "stopping" ? (
        <FullStackProgress label="Stopping full-stack preview..." />
      ) : state.status === "error" ? (
        <section className="peephole__job peephole__job--error" role="alert">
          <strong>Full-stack preview request failed</strong>
          <p>{state.message}</p>
          <button
            className="peephole__secondary"
            onClick={() => {
              if (state.preview) {
                setState({ status: "preview", preview: state.preview })
              } else {
                start()
              }
            }}
            type="button"
          >
            {state.preview ? "Check status" : "Retry"}
          </button>
        </section>
      ) : (
        <FullStackPreviewState
          preview={state.preview}
          previewArtifactBaseDomain={previewArtifactBaseDomain}
          onReset={() => {
            createKey.current = null
            setState({ status: "idle" })
          }}
          onStop={() =>
            stopFullStackPreview(
              fullStackPreviewApi,
              state.preview,
              activeRequest,
              setState,
              setAuthenticationStatus,
            )
          }
        />
      )}
    </section>
  )
}

function FullStackPreviewState({
  preview,
  previewArtifactBaseDomain,
  onReset,
  onStop,
}: {
  preview: FullStackPreview
  previewArtifactBaseDomain: string | null
  onReset: () => void
  onStop: () => void
}) {
  if (preview.status === "ready") {
    const trusted =
      preview.url !== null &&
      isTrustedFullStackPreviewUrl(preview.url, previewArtifactBaseDomain)
    return (
      <section className="peephole__job peephole__job--ready" role="status">
        <strong>Full-stack preview ready</strong>
        {trusted && preview.url ? (
          <>
            <iframe
              className="peephole__preview-frame"
              referrerPolicy="no-referrer"
              sandbox="allow-scripts allow-same-origin allow-forms"
              src={preview.url}
              title="Peephole full-stack preview"
            />
            <a
              className="peephole__link"
              href={preview.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              Open full-stack preview in a new tab
            </a>
          </>
        ) : (
          <p>The returned preview origin is not approved for embedding.</p>
        )}
        <button className="peephole__secondary" onClick={onStop} type="button">
          Stop full-stack preview
        </button>
      </section>
    )
  }

  if (TERMINAL_STATUSES.has(preview.status)) {
    return (
      <section
        className={`peephole__job${preview.status === "failed" ? " peephole__job--error" : ""}`}
        role={preview.status === "failed" ? "alert" : "status"}
      >
        <strong>{formatStatus(preview.status)}</strong>
        {preview.errorMessage && <p>{preview.errorMessage}</p>}
        <button className="peephole__secondary" onClick={onReset} type="button">
          Run again
        </button>
      </section>
    )
  }

  return (
    <section className="peephole__job" role="status">
      <div className="peephole__job-heading">
        <span aria-hidden="true" className="peephole__spinner" />
        <strong>{formatStatus(preview.status)}</strong>
      </div>
      <p>Full-stack job {preview.id}</p>
      <button className="peephole__secondary" onClick={onStop} type="button">
        Cancel full-stack preview
      </button>
    </section>
  )
}

function FullStackProgress({ label }: { label: string }) {
  return (
    <div className="peephole__job" role="status">
      <div className="peephole__job-heading">
        <span aria-hidden="true" className="peephole__spinner" />
        <strong>{label}</strong>
      </div>
    </div>
  )
}

function FullStackNotice({ message }: { message: string }) {
  return <p className="peephole__muted">{message}</p>
}

function startFullStackPreview(
  api: FullStackPreviewApi,
  request: ReturnType<typeof createFullStackPreviewRequest>,
  activeRequest: MutableRefObject<AbortController | null>,
  setState: Dispatch<SetStateAction<FullStackPreviewUiState>>,
  createKey: MutableRefObject<string | null>,
  setAuthenticationStatus: Dispatch<SetStateAction<AuthenticationStatus>>,
): void {
  if (activeRequest.current && !activeRequest.current.signal.aborted) return
  activeRequest.current?.abort()
  const abortController = new AbortController()
  activeRequest.current = abortController
  setState({ status: "creating" })
  createKey.current ??= `fullstack-request-${crypto.randomUUID()}`

  void api
    .create(request, {
      signal: abortController.signal,
      idempotencyKey: createKey.current,
    })
    .then(
      (preview) => {
        if (!abortController.signal.aborted) {
          activeRequest.current = null
          setState({ status: "preview", preview })
        }
      },
      (error: unknown) => {
        if (!abortController.signal.aborted) {
          activeRequest.current = null
          setState(createErrorState(error))
          if (isAuthenticationError(error)) {
            setAuthenticationStatus("unauthenticated")
          }
        }
      },
    )
}

function stopFullStackPreview(
  api: FullStackPreviewApi,
  preview: FullStackPreview,
  activeRequest: MutableRefObject<AbortController | null>,
  setState: Dispatch<SetStateAction<FullStackPreviewUiState>>,
  setAuthenticationStatus: Dispatch<SetStateAction<AuthenticationStatus>>,
): void {
  if (activeRequest.current && !activeRequest.current.signal.aborted) return
  activeRequest.current?.abort()
  const abortController = new AbortController()
  activeRequest.current = abortController
  setState({ status: "stopping", preview })

  void api.stop(preview.id, { signal: abortController.signal }).then(
    (stopped) => {
      if (!abortController.signal.aborted) {
        activeRequest.current = null
        setState({ status: "preview", preview: stopped })
      }
    },
    (error: unknown) => {
      if (!abortController.signal.aborted) {
        activeRequest.current = null
        setState(createErrorState(error, preview))
        if (isAuthenticationError(error)) {
          setAuthenticationStatus("unauthenticated")
        }
      }
    },
  )
}

function formatCandidate(candidate: BackendCandidate): string {
  const framework =
    candidate.framework === "unknown" ? "Node.js" : candidate.framework
  return `${candidate.sourceRoot} (${framework})`
}

function formatStatus(status: FullStackPreview["status"]): string {
  return {
    queued: "Queued",
    building_frontend: "Building frontend",
    starting_backend: "Starting backend",
    awaiting_activation: "Activating secure preview",
    ready: "Full-stack preview ready",
    stopping: "Stopping full-stack preview",
    stopped: "Full-stack preview stopped",
    failed: "Full-stack preview failed",
    cancelled: "Full-stack preview cancelled",
    expired: "Full-stack preview expired",
  }[status]
}

function isAuthenticationError(error: unknown): boolean {
  return (
    error instanceof FullStackPreviewApiError && error.code === "UNAUTHORIZED"
  )
}

function createErrorState(
  error: unknown,
  preview?: FullStackPreview,
  requiresAuthentication = isAuthenticationError(error),
): Extract<FullStackPreviewUiState, { status: "error" }> {
  return {
    status: "error",
    message:
      error instanceof Error
        ? error.message
        : "The full-stack preview service could not complete the request.",
    requiresAuthentication,
    ...(preview ? { preview } : {}),
  }
}
