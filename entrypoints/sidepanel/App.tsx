import { RepositoryAnalysisView } from "../../components/RepositoryAnalysisView"
import { PreviewJobPanel } from "../../components/PreviewJobPanel"
import type { PreviewApi } from "../../core/preview/apiClient"
import type { RepositoryAnalysisLoader } from "../../types/analysis"
import type { RepositoryIdentity } from "../../types/repository"

interface SidePanelAppProps {
  repository: RepositoryIdentity | null
  loadRepositoryAnalysis: RepositoryAnalysisLoader
  previewApi: PreviewApi | null
  previewConfigurationError?: string | null
}

export function SidePanelApp({
  repository,
  loadRepositoryAnalysis,
  previewApi,
  previewConfigurationError = null,
}: SidePanelAppProps) {
  return (
    <main className="peephole-panel">
      <header className="peephole__header">
        <div>
          <p className="peephole__eyebrow">Repository analysis</p>
          <h1 className="peephole__title">Peephole</h1>
        </div>
      </header>

      {repository ? (
        <RepositoryAnalysisView
          loadRepositoryAnalysis={loadRepositoryAnalysis}
          repository={repository}
          renderPreviewControls={(analysis) => (
            <PreviewJobPanel
              analysis={analysis}
              configurationError={previewConfigurationError}
              key={`${analysis.repository.repositoryId}:${analysis.repository.commitSha}`}
              previewApi={previewApi}
            />
          )}
        />
      ) : (
        <section className="peephole__empty">
          <strong>No repository selected</strong>
          <p>Open a GitHub repository and click its Peephole button.</p>
        </section>
      )}
    </main>
  )
}
