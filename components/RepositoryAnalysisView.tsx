import { useEffect, useId, useState, type ReactNode } from "react"

import { DEFAULT_REPOSITORY_REF } from "../core/github/repositoryRef"
import type {
  Framework,
  PreviewMode,
  RepositoryAnalysis,
  RepositoryAnalysisLoader,
} from "../types/analysis"
import type {
  RepositoryBranchList,
  RepositoryBranchesLoader,
  RepositoryIdentity,
  RepositoryRefSelection,
} from "../types/repository"

interface RepositoryAnalysisViewProps {
  repository: RepositoryIdentity
  loadRepositoryAnalysis: RepositoryAnalysisLoader
  loadRepositoryBranches: RepositoryBranchesLoader
  renderPreviewControls?: (analysis: RepositoryAnalysis) => ReactNode
}

type AnalysisState =
  | { status: "loading"; previous: RepositoryAnalysis | null }
  | { status: "ready"; value: RepositoryAnalysis }
  | {
      status: "error"
      message: string
      previous: RepositoryAnalysis | null
    }

type BranchState =
  | { status: "loading" }
  | { status: "ready"; value: RepositoryBranchList }
  | { status: "error"; message: string }

export function RepositoryAnalysisView(props: RepositoryAnalysisViewProps) {
  const repositoryKey = `${props.repository.owner.toLowerCase()}/${props.repository.repo.toLowerCase()}`

  return <RepositoryAnalysisSession key={repositoryKey} {...props} />
}

function RepositoryAnalysisSession({
  repository,
  loadRepositoryAnalysis,
  loadRepositoryBranches,
  renderPreviewControls,
}: RepositoryAnalysisViewProps) {
  const [analysisState, setAnalysisState] = useState<AnalysisState>({
    status: "loading",
    previous: null,
  })
  const [analysisRequestVersion, setAnalysisRequestVersion] = useState(0)
  const [branchState, setBranchState] = useState<BranchState>({
    status: "loading",
  })
  const [branchRequestVersion, setBranchRequestVersion] = useState(0)
  const [selectedRef, setSelectedRef] = useState<RepositoryRefSelection>(
    DEFAULT_REPOSITORY_REF,
  )

  useEffect(() => {
    const abortController = new AbortController()
    setBranchState({ status: "loading" })

    const load = async () => {
      try {
        const value = await loadRepositoryBranches(repository, {
          signal: abortController.signal,
        })
        if (!abortController.signal.aborted) {
          setBranchState({ status: "ready", value })
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          setBranchState({
            status: "error",
            message: getErrorMessage(
              error,
              "Repository branches could not be loaded.",
            ),
          })
        }
      }
    }

    void load()
    return () => abortController.abort()
  }, [
    branchRequestVersion,
    loadRepositoryBranches,
    repository.owner,
    repository.repo,
  ])

  useEffect(() => {
    const abortController = new AbortController()
    setAnalysisState((current) => ({
      status: "loading",
      previous: getPreservedAnalysis(current),
    }))

    const load = async () => {
      try {
        const value = await loadRepositoryAnalysis(
          { repository, ref: selectedRef },
          { signal: abortController.signal },
        )
        if (!abortController.signal.aborted) {
          setAnalysisState({ status: "ready", value })
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          setAnalysisState((current) => ({
            status: "error",
            message: getErrorMessage(
              error,
              "Repository analysis could not be completed.",
            ),
            previous: getPreservedAnalysis(current),
          }))
        }
      }
    }

    void load()
    return () => abortController.abort()
  }, [
    analysisRequestVersion,
    loadRepositoryAnalysis,
    repository.owner,
    repository.repo,
    selectedRef.kind,
    selectedRef.kind === "branch" ? selectedRef.name : "",
  ])

  const preservedAnalysis = getPreservedAnalysis(analysisState)
  const visibleAnalysis =
    analysisState.status === "ready" ? analysisState.value : null
  const selectedBranch = getSelectedBranchName(
    selectedRef,
    branchState,
    preservedAnalysis,
  )

  return (
    <>
      <RepositoryIdentityDetails
        analysis={visibleAnalysis}
        repository={repository}
      />
      <BranchSelector
        branchState={branchState}
        onRetry={() => setBranchRequestVersion((version) => version + 1)}
        onSelect={(branchName) => {
          const defaultBranch =
            branchState.status === "ready"
              ? branchState.value.defaultBranch
              : preservedAnalysis?.repository.defaultBranch
          setSelectedRef(
            branchName === defaultBranch
              ? DEFAULT_REPOSITORY_REF
              : { kind: "branch", name: branchName },
          )
        }}
        selectedBranch={selectedBranch}
      />
      <AnalysisContent
        analysisState={analysisState}
        onRetry={() => setAnalysisRequestVersion((version) => version + 1)}
        renderPreviewControls={renderPreviewControls}
        selectedBranch={selectedBranch}
      />
    </>
  )
}

function BranchSelector({
  branchState,
  onRetry,
  onSelect,
  selectedBranch,
}: {
  branchState: BranchState
  onRetry: () => void
  onSelect: (branchName: string) => void
  selectedBranch: string
}) {
  const descriptionId = useId()
  const options =
    branchState.status === "ready"
      ? includeSelectedBranch(branchState.value.branches, selectedBranch)
      : selectedBranch
        ? [selectedBranch]
        : []
  const disabled = branchState.status !== "ready"

  return (
    <section className="peephole__branch">
      <label className="peephole__branch-label" htmlFor="peephole-branch">
        Preview branch
      </label>
      <select
        aria-describedby={descriptionId}
        className="peephole__branch-select"
        disabled={disabled}
        id="peephole-branch"
        name="branch"
        onChange={(event) => onSelect(event.currentTarget.value)}
        value={selectedBranch}
      >
        {options.length > 0 ? (
          options.map((branch) => (
            <option key={branch} value={branch}>
              {branch}
            </option>
          ))
        ) : (
          <option value="">Loading branches...</option>
        )}
      </select>
      <div className="peephole__branch-help" id={descriptionId}>
        {branchState.status === "loading" &&
          "Loading the bounded GitHub branch list. Default-branch analysis continues independently."}
        {branchState.status === "ready" &&
          branchState.value.truncated &&
          "Showing up to 100 branches, including the default branch. More branches may exist."}
        {branchState.status === "ready" &&
          !branchState.value.truncated &&
          "Each selection is resolved to its current full commit SHA before analysis."}
        {branchState.status === "error" && (
          <>
            <span>{branchState.message}</span>{" "}
            <button
              className="peephole__inline-retry"
              onClick={onRetry}
              type="button"
            >
              Retry branch list
            </button>
          </>
        )}
      </div>
    </section>
  )
}

function RepositoryIdentityDetails({
  repository,
  analysis,
}: {
  repository: RepositoryIdentity
  analysis: RepositoryAnalysis | null
}) {
  return (
    <dl className="peephole__details">
      <Detail label="Owner" value={repository.owner} />
      <Detail label="Repository" value={repository.repo} />
      {analysis && (
        <>
          <div className="peephole__detail">
            <dt>Commit</dt>
            <dd>
              <code title={analysis.repository.commitSha}>
                {analysis.repository.commitSha.slice(0, 7)}
              </code>
            </dd>
          </div>
          <div className="peephole__detail">
            <dt>Homepage</dt>
            <dd>
              {analysis.repository.homepage ? (
                <a
                  className="peephole__link"
                  href={analysis.repository.homepage}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  Open site
                </a>
              ) : (
                "Not declared"
              )}
            </dd>
          </div>
        </>
      )}
    </dl>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="peephole__detail">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function AnalysisContent({
  analysisState,
  onRetry,
  renderPreviewControls,
  selectedBranch,
}: {
  analysisState: AnalysisState
  onRetry: () => void
  renderPreviewControls?: (analysis: RepositoryAnalysis) => ReactNode
  selectedBranch: string
}) {
  const preservedAnalysis = getPreservedAnalysis(analysisState)
  const ready = analysisState.status === "ready"

  return (
    <>
      {analysisState.status === "loading" && (
        <div aria-live="polite" className="peephole__status">
          <span aria-hidden="true" className="peephole__spinner" />
          Resolving and inspecting {selectedBranch || "the default branch"}...
        </div>
      )}

      {analysisState.status === "error" && (
        <div className="peephole__status peephole__status--error" role="alert">
          <p>{analysisState.message}</p>
          <button className="peephole__retry" onClick={onRetry} type="button">
            Retry analysis
          </button>
        </div>
      )}

      {preservedAnalysis && (
        <div hidden={!ready}>
          <AnalysisResults
            analysis={preservedAnalysis}
            renderPreviewControls={renderPreviewControls}
          />
        </div>
      )}
    </>
  )
}

function AnalysisResults({
  analysis,
  renderPreviewControls,
}: {
  analysis: RepositoryAnalysis
  renderPreviewControls?: (analysis: RepositoryAnalysis) => ReactNode
}) {
  return (
    <div className="peephole__analysis">
      <PreviewStatus mode={analysis.preview.mode} />
      {renderPreviewControls?.(analysis)}

      <section className="peephole__section">
        <h3>Stack</h3>
        <dl className="peephole__facts">
          <Detail
            label="Framework"
            value={formatFramework(analysis.technologies.framework)}
          />
          <Detail
            label="TypeScript"
            value={
              analysis.technologies.typescript ? "Detected" : "Not detected"
            }
          />
          <Detail label="Package" value={analysis.packageManager} />
        </dl>
      </section>

      <section className="peephole__section">
        <h3>Build plan</h3>
        <dl className="peephole__facts">
          <Detail
            label="Native build"
            value={
              analysis.preview.blockers.length === 0 ? "Compatible" : "Blocked"
            }
          />
          <Detail
            label="Install"
            value={analysis.runtime.installCommand ?? "Not required"}
          />
          <Detail
            label="Build"
            value={analysis.runtime.buildCommand ?? "Not required"}
          />
          <Detail
            label="Output"
            value={analysis.runtime.outputDirectory ?? "Unknown"}
          />
        </dl>
      </section>

      <section className="peephole__section">
        <h3>Environment</h3>
        {analysis.environment.variables.length > 0 ? (
          <ul aria-label="Environment variables" className="peephole__chips">
            {analysis.environment.variables.map((variable) => (
              <li key={variable}>{variable}</li>
            ))}
          </ul>
        ) : (
          <p className="peephole__muted">No template variables detected.</p>
        )}
      </section>

      {analysis.preview.blockers.length > 0 && (
        <section className="peephole__section peephole__section--blocked">
          <h3>Blockers</h3>
          <ul className="peephole__list">
            {analysis.preview.blockers.map((blocker) => (
              <li key={`${blocker.code}:${blocker.message}`}>
                {blocker.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      {analysis.warnings.length > 0 && (
        <section className="peephole__section">
          <h3>Warnings</h3>
          <ul className="peephole__list">
            {analysis.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      )}

      <details className="peephole__evidence">
        <summary>Evidence ({analysis.preview.evidence.length})</summary>
        <ul className="peephole__list">
          {analysis.preview.evidence.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p>{analysis.inspectedFiles.length} known files detected</p>
      </details>
    </div>
  )
}

function PreviewStatus({ mode }: { mode: PreviewMode }) {
  const content = {
    "native-static-build": {
      title: "Native preview compatible",
      description: "The repository matches Peephole's static-v1 contract.",
      modifier: "ready",
    },
    "existing-deployment": {
      title: "Existing deployment available",
      description: "A confirmed deployment is the fastest preview path.",
      modifier: "info",
    },
    unsupported: {
      title: "Native preview blocked",
      description: "Review the blockers before creating a preview job.",
      modifier: "blocked",
    },
  }[mode]

  return (
    <div
      className={`peephole__status peephole__status--${content.modifier}`}
      role="status"
    >
      <strong>{content.title}</strong>
      <span>{content.description}</span>
    </div>
  )
}

function getSelectedBranchName(
  selectedRef: RepositoryRefSelection,
  branchState: BranchState,
  analysis: RepositoryAnalysis | null,
): string {
  if (selectedRef.kind === "branch") return selectedRef.name
  if (branchState.status === "ready") return branchState.value.defaultBranch
  return analysis?.repository.defaultBranch ?? ""
}

function includeSelectedBranch(
  branches: string[],
  selectedBranch: string,
): string[] {
  return selectedBranch && !branches.includes(selectedBranch)
    ? [selectedBranch, ...branches]
    : branches
}

function getPreservedAnalysis(state: AnalysisState): RepositoryAnalysis | null {
  return state.status === "ready" ? state.value : state.previous
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function formatFramework(framework: Framework): string {
  return (
    {
      static: "Static HTML",
      "react-vite": "React + Vite",
      "vue-vite": "Vue + Vite",
      "svelte-vite": "Svelte + Vite",
      wxt: "WXT",
      next: "Next.js",
      react: "React",
      unknown: "Unknown",
    } satisfies Record<Framework, string>
  )[framework]
}
