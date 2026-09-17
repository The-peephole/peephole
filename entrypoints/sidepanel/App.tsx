import { RepositoryAnalysisView } from "../../components/RepositoryAnalysisView"
import { PreviewJobPanel } from "../../components/PreviewJobPanel"
import type { PreviewApi } from "../../core/preview/apiClient"
import type {
  BuildTargetAnalysisLoader,
  RepositoryAnalysisLoader,
} from "../../types/analysis"
import type { RepositoryLiveDeploymentLoader } from "../../types/deployment"
import type {
  RepositoryBranchesLoader,
  RepositoryIdentity,
} from "../../types/repository"

interface SidePanelAppProps {
  repository: RepositoryIdentity | null
  loadRepositoryAnalysis: RepositoryAnalysisLoader
  loadBuildTargetAnalysis: BuildTargetAnalysisLoader
  loadRepositoryBranches: RepositoryBranchesLoader
  loadRepositoryLiveDeployment: RepositoryLiveDeploymentLoader
  connectGitHub?: (() => Promise<void>) | null
  previewApi: PreviewApi | null
  previewArtifactBaseDomain?: string | null
  previewConfigurationError?: string | null
}

export function SidePanelApp({
  repository,
  loadRepositoryAnalysis,
  loadBuildTargetAnalysis,
  loadRepositoryBranches,
  loadRepositoryLiveDeployment,
  connectGitHub = null,
  previewApi,
  previewConfigurationError = null,
  previewArtifactBaseDomain = null,
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
          loadBuildTargetAnalysis={loadBuildTargetAnalysis}
          loadRepositoryBranches={loadRepositoryBranches}
          loadRepositoryLiveDeployment={loadRepositoryLiveDeployment}
          repository={repository}
          renderPreviewControls={(analysis) => (
            <PreviewJobPanel
              analysis={analysis}
              configurationError={previewConfigurationError}
              connectGitHub={connectGitHub}
              key={`${analysis.repository.repositoryId}:${analysis.repository.commitSha}:${analysis.target.sourceRoot}`}
              previewApi={previewApi}
              previewArtifactBaseDomain={previewArtifactBaseDomain}
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
