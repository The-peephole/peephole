import { useEffect, useId, useState } from "react"

import type {
  Framework,
  PreviewMode,
  RepositoryAnalysis,
  RepositoryAnalysisLoader,
} from "../types/analysis"
import type { RepositoryIdentity } from "../types/repository"

interface PeepholeAppProps {
  repository: RepositoryIdentity
  loadRepositoryAnalysis: RepositoryAnalysisLoader
}

type AnalysisState =
  | { status: "idle" | "loading" }
  | { status: "ready"; value: RepositoryAnalysis }
  | { status: "error"; message: string }

export function PeepholeApp({
  repository,
  loadRepositoryAnalysis,
}: PeepholeAppProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [analysisState, setAnalysisState] = useState<AnalysisState>({
    status: "idle",
  })
  const [requestVersion, setRequestVersion] = useState(0)
  const panelId = useId()

  useEffect(() => {
    setIsOpen(false)
    setAnalysisState({ status: "idle" })
    setRequestVersion(0)
  }, [repository.owner, repository.repo])

  useEffect(() => {
    if (!isOpen) {
      return
    }

    const abortController = new AbortController()
    setAnalysisState({ status: "loading" })

    void loadRepositoryAnalysis(repository, {
      signal: abortController.signal,
    }).then(
      (analysis) => {
        if (!abortController.signal.aborted) {
          setAnalysisState({ status: "ready", value: analysis })
        }
      },
      (error: unknown) => {
        if (!abortController.signal.aborted) {
          setAnalysisState({
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "Repository analysis could not be completed.",
          })
        }
      },
    )

    return () => abortController.abort()
  }, [
    isOpen,
    loadRepositoryAnalysis,
    repository.owner,
    repository.repo,
    requestVersion,
  ])

  return (
    <div className="peephole" onClick={(event) => event.stopPropagation()}>
      <button
        aria-controls={panelId}
        aria-expanded={isOpen}
        className="peephole__trigger"
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setIsOpen((open) => !open)
        }}
        type="button"
      >
        <span aria-hidden="true" className="peephole__mark">
          P
        </span>
        Peephole
      </button>

      {isOpen && (
        <section
          aria-label="Peephole repository preview"
          className="peephole__panel"
          id={panelId}
        >
          <header className="peephole__header">
            <div>
              <p className="peephole__eyebrow">Repository analysis</p>
              <h2 className="peephole__title">Peephole</h2>
            </div>
            <button
              aria-label="Close Peephole panel"
              className="peephole__close"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setIsOpen(false)
              }}
              type="button"
            >
              &times;
            </button>
          </header>

          <RepositoryIdentityDetails
            analysis={
              analysisState.status === "ready" ? analysisState.value : null
            }
            repository={repository}
          />

          <AnalysisContent
            analysisState={analysisState}
            onRetry={() => setRequestVersion((version) => version + 1)}
          />
        </section>
      )}
    </div>
  )
}

interface RepositoryIdentityDetailsProps {
  repository: RepositoryIdentity
  analysis: RepositoryAnalysis | null
}

function RepositoryIdentityDetails({
  repository,
  analysis,
}: RepositoryIdentityDetailsProps) {
  return (
    <dl className="peephole__details">
      <Detail label="Owner" value={repository.owner} />
      <Detail label="Repository" value={repository.repo} />
      {analysis && (
        <>
          <Detail label="Branch" value={analysis.repository.defaultBranch} />
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
                  onClick={(event) => event.stopPropagation()}
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

interface AnalysisContentProps {
  analysisState: AnalysisState
  onRetry: () => void
}

function AnalysisContent({ analysisState, onRetry }: AnalysisContentProps) {
  if (analysisState.status === "loading") {
    return (
      <div aria-live="polite" className="peephole__status">
        <span aria-hidden="true" className="peephole__spinner" />
        Inspecting known repository files...
      </div>
    )
  }

  if (analysisState.status === "error") {
    return (
      <div className="peephole__status peephole__status--error" role="alert">
        <p>{analysisState.message}</p>
        <button
          className="peephole__retry"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onRetry()
          }}
          type="button"
        >
          Retry
        </button>
      </div>
    )
  }

  if (analysisState.status !== "ready") {
    return null
  }

  const analysis = analysisState.value

  return (
    <div className="peephole__analysis">
      <PreviewStatus mode={analysis.preview.mode} />

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
          <ul className="peephole__chips" aria-label="Environment variables">
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
