import { useCallback, useState } from "react"

import { RepositoryAnalysisView } from "../../components/RepositoryAnalysisView"
import { BackendRuntimeControl } from "../../components/BackendRuntimeControl"
import { FullStackPreviewPanel } from "../../components/FullStackPreviewPanel"
import { PreviewJobPanel } from "../../components/PreviewJobPanel"
import { UserEnvironmentEnabledContext } from "../../components/userEnvironmentContext"
import type { BackendRuntimeApi } from "../../core/backendRuntime/apiClient"
import type { FullStackPreviewApi } from "../../core/fullstack/apiClient"
import type { PreviewApi } from "../../core/preview/apiClient"
import type {
  BuildTargetAnalysis,
  BuildTargetAnalysisLoader,
  RepositoryAnalysis,
  RepositoryAnalysisLoader,
} from "../../types/analysis"
import type { RepositoryLiveDeploymentLoader } from "../../types/deployment"
import type { FullStackPreview } from "../../types/fullstackPreview"
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
  fullStackPreviewApi?: FullStackPreviewApi | null
  /** Separate from backend-v1. Kept build-time opt-in until production E2E
   * has been explicitly approved and completed for the extension build. */
  fullStackPreviewEnabled?: boolean
  /** M12 user-provided configuration; build-time opt-in. */
  userEnvironmentEnabled?: boolean
}

interface RetainedFullStackControl {
  analysis: BuildTargetAnalysis & RepositoryAnalysis
  preview: FullStackPreview
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
  fullStackPreviewApi = null,
  fullStackPreviewEnabled = false,
  userEnvironmentEnabled = false,
}: SidePanelAppProps) {
  const [retainedFullStackControl, setRetainedFullStackControl] =
    useState<RetainedFullStackControl | null>(null)
  const updateRetainedFullStackPreview = useCallback(
    (preview: FullStackPreview | null) => {
      setRetainedFullStackControl((current) =>
        preview && current ? { ...current, preview } : null,
      )
    },
    [],
  )

  return (
    <UserEnvironmentEnabledContext.Provider value={userEnvironmentEnabled}>
      <main className="peephole-panel">
        <header className="peephole__header">
          <div>
            <p className="peephole__eyebrow">Repository analysis</p>
            <h1 className="peephole__title">Peephole</h1>
          </div>
        </header>

        {fullStackPreviewEnabled && retainedFullStackControl && (
          <FullStackPreviewPanel
            analysis={retainedFullStackControl.analysis}
            configurationError={previewConfigurationError}
            connectGitHub={connectGitHub}
            fullStackPreviewApi={fullStackPreviewApi}
            key={`active:${retainedFullStackControl.preview.id}`}
            onRetainedPreviewChange={updateRetainedFullStackPreview}
            previewArtifactBaseDomain={previewArtifactBaseDomain}
            retainedPreview={retainedFullStackControl.preview}
          />
        )}

        {repository ? (
          <RepositoryAnalysisView
            hasRetainedFullStackPreview={Boolean(retainedFullStackControl)}
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
            renderFullStackPreviewControls={
              fullStackPreviewEnabled
                ? (analysis, options) =>
                    retainedFullStackControl ? null : (
                      <FullStackPreviewPanel
                        analysis={analysis}
                        configurationError={previewConfigurationError}
                        connectGitHub={connectGitHub}
                        fullStackPreviewApi={fullStackPreviewApi}
                        key={`${analysis.repository.repositoryId}:${analysis.repository.commitSha}:${analysis.target.sourceRoot}`}
                        onCreatePendingChange={options?.onCreatePendingChange}
                        onRetainedPreviewChange={(preview) =>
                          setRetainedFullStackControl(
                            preview ? { analysis, preview } : null,
                          )
                        }
                        previewArtifactBaseDomain={previewArtifactBaseDomain}
                        retainedPreview={null}
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
    </UserEnvironmentEnabledContext.Provider>
  )
}
