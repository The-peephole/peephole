import { useEffect, useState, type ReactNode } from "react"

import type {
  Framework,
  PreviewMode,
  RepositoryAnalysis,
  RepositoryAnalysisLoader,
} from "../types/analysis"
import type { RepositoryIdentity } from "../types/repository"

interface RepositoryAnalysisViewProps {
  repository: RepositoryIdentity
  loadRepositoryAnalysis: RepositoryAnalysisLoader
  renderPreviewControls?: (analysis: RepositoryAnalysis) => ReactNode
}

type AnalysisState =
  | { status: "loading" }
  | { status: "ready"; value: RepositoryAnalysis }
  | { status: "error"; message: string }

export function RepositoryAnalysisView({
  repository,
  loadRepositoryAnalysis,
  renderPreviewControls,
}: RepositoryAnalysisViewProps) {
  const [analysisState, setAnalysisState] = useState<AnalysisState>({
    status: "loading",
  })
  const [requestVersion, setRequestVersion] = useState(0)

  useEffect(() => {
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
    loadRepositoryAnalysis,
    repository.owner,
    repository.repo,
    requestVersion,
  ])

  const analysis = analysisState.status === "ready" ? analysisState.value : null

  return (
    <>
      <RepositoryIdentityDetails analysis={analysis} repository={repository} />
      <AnalysisContent
        analysisState={analysisState}
        onRetry={() => setRequestVersion((version) => version + 1)}
        renderPreviewControls={renderPreviewControls}
      />
    </>
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
}: {
  analysisState: AnalysisState
  onRetry: () => void
  renderPreviewControls?: (analysis: RepositoryAnalysis) => ReactNode
}) {
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
          onClick={() => onRetry()}
          type="button"
        >
          Retry
        </button>
      </div>
    )
  }

  const analysis = analysisState.value

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
