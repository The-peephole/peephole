import { useEffect, useId, useMemo, useState, type ReactNode } from "react"

import { resolveFullStackCandidateSupport } from "../core/fullstack/candidateSupport"
import type {
  BuildTargetAnalysis,
  BuildTargetAnalysisLoader,
  Framework,
  RepositoryAnalysis,
} from "../types/analysis"
import type { BackendCandidate } from "../types/backend"
import type { RepositoryProjectCandidate } from "../types/structure"

interface RootFullStackDiscoveryProps {
  analysis: RepositoryAnalysis
  hasRetainedFullStackPreview?: boolean
  loadBuildTargetAnalysis: BuildTargetAnalysisLoader
  onRetryStructure: () => void
  renderControls: (
    analysis: BuildTargetAnalysis & RepositoryAnalysis,
    options?: FullStackPreviewRenderOptions,
  ) => ReactNode
}

export interface FullStackPreviewRenderOptions {
  onCreatePendingChange?: (pending: boolean) => void
}

type CandidateResult =
  | {
      status: "ready"
      project: RepositoryProjectCandidate
      value: BuildTargetAnalysis
    }
  | {
      status: "error"
      project: RepositoryProjectCandidate
      message: string
    }

type DiscoveryState =
  { status: "loading" } | { status: "ready"; results: CandidateResult[] }

export function RootFullStackDiscovery({
  analysis,
  hasRetainedFullStackPreview = false,
  loadBuildTargetAnalysis,
  onRetryStructure,
  renderControls,
}: RootFullStackDiscoveryProps) {
  const titleId = useId()
  const selectId = useId()
  const selectHelpId = useId()
  const candidates = useMemo(() => {
    const backendSourceRoots = new Set(
      analysis.backend.candidates.map((candidate) => candidate.sourceRoot),
    )
    return analysis.structure.projects.filter(
      (project) =>
        !project.isRoot &&
        project.role === "project-candidate" &&
        !backendSourceRoots.has(project.path),
    )
  }, [analysis.backend.candidates, analysis.structure.projects])
  const [requestVersion, setRequestVersion] = useState(0)
  const [state, setState] = useState<DiscoveryState>({ status: "loading" })
  const [selectedSourceRoot, setSelectedSourceRoot] = useState("")
  const [createPending, setCreatePending] = useState(false)
  const structureIsComplete =
    analysis.structure.complete && !analysis.structure.truncated

  useEffect(() => {
    if (!structureIsComplete || candidates.length === 0) return

    const abortController = new AbortController()
    setState({ status: "loading" })
    setSelectedSourceRoot("")

    const load = async () => {
      const results = await Promise.all(
        candidates.map(async (project): Promise<CandidateResult> => {
          try {
            const value = await loadBuildTargetAnalysis(
              analysis.repository,
              { sourceRoot: project.path },
              { signal: abortController.signal },
            )
            if (!matchesDiscoveryIdentity(analysis, project, value)) {
              throw new Error(
                "The target analysis did not match the requested repository commit.",
              )
            }
            return { status: "ready", project, value }
          } catch (error) {
            return {
              status: "error",
              project,
              message: getErrorMessage(
                error,
                "This frontend candidate could not be analyzed.",
              ),
            }
          }
        }),
      )

      if (abortController.signal.aborted) return
      setState({ status: "ready", results })
      const eligible = results.filter(isEligibleFrontend)
      setSelectedSourceRoot(
        eligible.length === 1 ? eligible[0]!.project.path : "",
      )
    }

    void load()
    return () => abortController.abort()
  }, [
    analysis,
    candidates,
    loadBuildTargetAnalysis,
    requestVersion,
    structureIsComplete,
  ])

  if (!structureIsComplete) {
    return (
      <section
        aria-labelledby={titleId}
        className="peephole__discovery peephole__status--blocked"
      >
        <h3 id={titleId}>Full-stack discovery unavailable</h3>
        <p>
          Repository structure analysis is incomplete or truncated, so Peephole
          will not guess a frontend/backend combination.
        </p>
        <button
          className="peephole__secondary"
          onClick={onRetryStructure}
          type="button"
        >
          Retry repository analysis
        </button>
      </section>
    )
  }

  if (candidates.length === 0) {
    return (
      <section aria-labelledby={titleId} className="peephole__discovery">
        <h3 id={titleId}>No nested full-stack application detected</h3>
        <p>
          Repository root remains unavailable for a native static preview, and
          no nested frontend candidate was found.
        </p>
      </section>
    )
  }

  if (state.status === "loading") {
    return (
      <div className="peephole__status" role="status">
        <span aria-hidden="true" className="peephole__spinner" />
        Inspecting nested frontend candidates for full-stack preview...
      </div>
    )
  }

  const failures = state.results.filter(
    (result): result is Extract<CandidateResult, { status: "error" }> =>
      result.status === "error",
  )
  const eligibleFrontends = state.results.filter(isEligibleFrontend)
  const unavailableFrontends = state.results.filter(
    (result): result is Extract<CandidateResult, { status: "ready" }> =>
      result.status === "ready" &&
      result.value.preview.mode !== "native-static-build",
  )

  if (failures.length > 0) {
    return (
      <section
        aria-labelledby={titleId}
        className="peephole__discovery peephole__status--error"
        role="alert"
      >
        <h3 id={titleId}>Full-stack discovery could not be completed</h3>
        <p>
          Peephole will not suggest a combination until every discovered
          frontend candidate has been checked.
        </p>
        <ul className="peephole__list">
          {failures.map((failure) => (
            <li key={failure.project.path}>
              <code>{failure.project.path}</code>: {failure.message}
            </li>
          ))}
        </ul>
        <button
          className="peephole__secondary"
          onClick={() => setRequestVersion((version) => version + 1)}
          type="button"
        >
          Retry full-stack discovery
        </button>
      </section>
    )
  }

  const repository = {
    repositoryId: analysis.repository.repositoryId,
    owner: analysis.repository.owner,
    name: analysis.repository.repo,
    commitSha: analysis.repository.commitSha,
  }
  const backendOptions = analysis.backend.candidates.map((candidate) => ({
    candidate,
    support: resolveFullStackCandidateSupport(repository, candidate),
  }))
  const supportedBackends = backendOptions.filter(
    ({ support }) => support.supported,
  )
  const backendDiscoveryIsComplete =
    analysis.backend.complete && !analysis.backend.truncated
  const selectedFrontend = eligibleFrontends.find(
    (result) => result.project.path === selectedSourceRoot,
  )
  const fullStackDetected =
    backendDiscoveryIsComplete &&
    eligibleFrontends.length > 0 &&
    supportedBackends.length > 0

  return (
    <section aria-labelledby={titleId} className="peephole__discovery">
      <h3 id={titleId}>
        {fullStackDetected
          ? "Full-stack application detected"
          : "Full-stack application not ready"}
      </h3>
      <p>
        Repository root remains unavailable for a native static preview.
        Peephole can pass an eligible nested frontend and backend to the
        existing fullstack-v1 admission flow.
      </p>

      {eligibleFrontends.length > 1 && (
        <div className="peephole__fullstack-target">
          <label className="peephole__branch-label" htmlFor={selectId}>
            Frontend target
          </label>
          <p className="peephole__branch-help" id={selectHelpId}>
            Multiple compatible frontends were detected. Choose the one that
            belongs with the backend you intend to run.
          </p>
          <select
            aria-describedby={selectHelpId}
            className="peephole__branch-select"
            disabled={createPending}
            id={selectId}
            name="fullstack-frontend-target"
            onChange={(event) => {
              if (createPending) return
              setSelectedSourceRoot(event.currentTarget.value)
            }}
            value={selectedSourceRoot}
          >
            <option value="">Choose a frontend</option>
            {eligibleFrontends.map(({ project, value }) => (
              <option key={project.path} value={project.path}>
                {project.path} ({formatFramework(value.technologies.framework)})
              </option>
            ))}
          </select>
        </div>
      )}

      {selectedFrontend && (
        <dl className="peephole__facts">
          <DiscoveryDetail
            label="Frontend"
            value={`${selectedFrontend.project.path} - ${formatFramework(selectedFrontend.value.technologies.framework)}`}
          />
          {supportedBackends.length === 1 && (
            <>
              <DiscoveryDetail
                label="Backend"
                value={`${supportedBackends[0]!.candidate.sourceRoot} - ${formatBackendFramework(supportedBackends[0]!.candidate)}`}
              />
              <DiscoveryDetail
                label="Database"
                value={formatDatabase(supportedBackends[0]!.candidate)}
              />
            </>
          )}
        </dl>
      )}

      {unavailableFrontends.length > 0 && (
        <CandidateReasons
          label="Unavailable frontend candidates"
          reasons={unavailableFrontends.map(({ project, value }) => ({
            sourceRoot: project.path,
            reason:
              value.preview.blockers[0]?.message ??
              "This target does not qualify for native-static-build.",
          }))}
        />
      )}

      {eligibleFrontends.length === 0 && (
        <p className="peephole__muted">
          No nested frontend qualifies for native-static-build.
        </p>
      )}

      {hasRetainedFullStackPreview ? (
        <p className="peephole__muted">
          An existing full-stack preview remains available in the active job
          controls. Stop or finish it before running a new combination.
        </p>
      ) : !backendDiscoveryIsComplete ? (
        <p className="peephole__muted">
          Backend detection is incomplete or truncated. Peephole will not
          suggest a runnable combination.
        </p>
      ) : supportedBackends.length === 0 ? (
        <CandidateReasons
          label="Unavailable backend candidates"
          reasons={
            backendOptions.length > 0
              ? backendOptions.map(({ candidate, support }) => ({
                  sourceRoot: candidate.sourceRoot,
                  reason:
                    support.evidence[0] ??
                    "This backend is not eligible for fullstack-v1.",
                }))
              : [
                  {
                    sourceRoot: "Backend",
                    reason: "No backend candidate was detected.",
                  },
                ]
          }
        />
      ) : eligibleFrontends.length === 0 ? null : !selectedFrontend ? (
        <p className="peephole__muted">
          Choose an explicit frontend target to continue.
        </p>
      ) : (
        <>
          <p className="peephole__action-note">
            Detection does not start a job. The server remains authoritative,
            and a preview runs only after you press the button below.
          </p>
          {renderControls(
            { ...analysis, ...selectedFrontend.value },
            { onCreatePendingChange: setCreatePending },
          )}
        </>
      )}
    </section>
  )
}

function DiscoveryDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="peephole__detail">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function CandidateReasons({
  label,
  reasons,
}: {
  label: string
  reasons: Array<{ sourceRoot: string; reason: string }>
}) {
  return (
    <ul aria-label={label} className="peephole__list" role="list">
      {reasons.map(({ sourceRoot, reason }) => (
        <li key={sourceRoot}>
          <code>{sourceRoot}</code>: {reason}
        </li>
      ))}
    </ul>
  )
}

function isEligibleFrontend(
  result: CandidateResult,
): result is Extract<CandidateResult, { status: "ready" }> {
  return (
    result.status === "ready" &&
    result.value.preview.mode === "native-static-build"
  )
}

function matchesDiscoveryIdentity(
  analysis: RepositoryAnalysis,
  project: RepositoryProjectCandidate,
  target: BuildTargetAnalysis,
): boolean {
  return (
    target.repository.repositoryId === analysis.repository.repositoryId &&
    target.repository.commitSha === analysis.repository.commitSha &&
    target.target.sourceRoot === project.path
  )
}

function formatFramework(framework: Framework): string {
  return {
    static: "Static HTML",
    "react-vite": "React + Vite",
    "vue-vite": "Vue + Vite",
    "svelte-vite": "Svelte + Vite",
    wxt: "WXT",
    next: "Next.js",
    react: "React",
    unknown: "Unknown",
  }[framework]
}

function formatBackendFramework(candidate: BackendCandidate): string {
  return candidate.framework === "unknown"
    ? "Node.js"
    : candidate.framework[0]!.toUpperCase() + candidate.framework.slice(1)
}

function formatDatabase(candidate: BackendCandidate): string {
  return candidate.databaseDependencies.includes("pg")
    ? "PostgreSQL (pg)"
    : "Not detected"
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
