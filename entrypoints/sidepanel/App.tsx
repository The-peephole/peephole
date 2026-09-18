import { RepositoryAnalysisView } from "../../components/RepositoryAnalysisView"
import { BackendRuntimeControl } from "../../components/BackendRuntimeControl"
import { PreviewJobPanel } from "../../components/PreviewJobPanel"
import type { BackendRuntimeApi } from "../../core/backendRuntime/apiClient"
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
  backendRuntimeApi?: BackendRuntimeApi | null
  /** Backend-v1 is intentionally opt-in until production wires and verifies
   * its separate control plane and worker on a real gVisor host. */
  backendRuntimeEnabled?: boolean
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
  backendRuntimeApi = null,
  backendRuntimeEnabled = false,
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
          renderBackendRuntimeControls={
            backendRuntimeEnabled
              ? ({ candidate, repository: repo }) => (
                  <BackendRuntimeControl
                    backendRuntimeApi={backendRuntimeApi}
                    candidate={candidate}
                    connectGitHub={connectGitHub}
                    key={`${repo.repositoryId}:${repo.commitSha}:${candidate.sourceRoot}`}
                    repository={repo}
                  />
                )
              : undefined
          }
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
