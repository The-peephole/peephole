import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react"

import type { PreviewApi } from "../core/preview/apiClient"
import { createBuildPlanFromAnalysis } from "../core/preview/buildPlan"
import type { RepositoryAnalysis } from "../types/analysis"
import type { CreatePreviewJobRequest, PreviewJob } from "../types/preview"

const TERMINAL_STATUSES = new Set(["ready", "failed", "cancelled", "expired"])

type PreviewUiState =
  | { status: "idle" }
  | { status: "creating" }
  | { status: "job"; job: PreviewJob }
  | { status: "cancelling"; job: PreviewJob }
  | { status: "error"; message: string }

interface PreviewJobPanelProps {
  analysis: RepositoryAnalysis
  previewApi: PreviewApi | null
  configurationError?: string | null
  pollIntervalMs?: number
}

export function PreviewJobPanel({
  analysis,
  previewApi,
  configurationError = null,
  pollIntervalMs = 1_500,
}: PreviewJobPanelProps) {
  const [state, setState] = useState<PreviewUiState>({ status: "idle" })
  const activeRequest = useRef<AbortController | null>(null)
  const request = createRequest(analysis)
  const repositoryKey = `${analysis.repository.repositoryId}:${analysis.repository.commitSha}`

  useEffect(() => {
    activeRequest.current?.abort()
    activeRequest.current = null
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
          (job) => setState({ status: "job", job }),
          (error: unknown) => {
            if (!abortController.signal.aborted) {
              setState({ status: "error", message: safeErrorMessage(error) })
            }
          },
        )
    }, pollIntervalMs)

    return () => {
      window.clearTimeout(timeout)
      abortController.abort()
    }
  }, [pollIntervalMs, previewApi, state])

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

  if (state.status === "idle") {
    return (
      <section className="peephole__preview-action">
        <button
          className="peephole__primary"
          onClick={() =>
            startPreview(previewApi, request, activeRequest, setState)
          }
          type="button"
        >
          Build preview
        </button>
        <p className="peephole__action-note">
          Builds the pinned commit in the configured isolated preview service.
        </p>
      </section>
    )
  }

  if (state.status === "creating") {
    return <JobProgress label="Creating preview job..." />
  }

  if (state.status === "error") {
    return (
      <section className="peephole__job peephole__job--error" role="alert">
        <strong>Preview request failed</strong>
        <p>{state.message}</p>
        <button
          className="peephole__secondary"
          onClick={() => setState({ status: "idle" })}
          type="button"
        >
          Retry
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
      <section className="peephole__job peephole__job--ready" role="status">
        <strong>Preview ready</strong>
        <p>
          The artifact is ready. Trusted-origin validation and embedding are the
          next delivery step.
        </p>
      </section>
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
          onClick={() => setState({ status: "idle" })}
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
          onClick={() => setState({ status: "idle" })}
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
        onClick={() => cancelPreview(previewApi, job, activeRequest, setState)}
        type="button"
      >
        Cancel
      </button>
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
): void {
  activeRequest.current?.abort()
  const abortController = new AbortController()
  activeRequest.current = abortController
  setState({ status: "creating" })

  void previewApi.create(request, { signal: abortController.signal }).then(
    (job) => {
      if (!abortController.signal.aborted) setState({ status: "job", job })
    },
    (error: unknown) => {
      if (!abortController.signal.aborted) {
        setState({ status: "error", message: safeErrorMessage(error) })
      }
    },
  )
}

function cancelPreview(
  previewApi: PreviewApi,
  job: PreviewJob,
  activeRequest: MutableRefObject<AbortController | null>,
  setState: Dispatch<SetStateAction<PreviewUiState>>,
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
        setState({ status: "error", message: safeErrorMessage(error) })
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
