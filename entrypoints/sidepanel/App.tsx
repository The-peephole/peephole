import { useCallback, useLayoutEffect, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"

import { RepositoryAnalysisView } from "../../components/RepositoryAnalysisView"
import { BackendRuntimeControl } from "../../components/BackendRuntimeControl"
import { FullStackPreviewPanel } from "../../components/FullStackPreviewPanel"
import { PreviewJobPanel } from "../../components/PreviewJobPanel"
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
import type { RetainedFullStackControl } from "../../core/sidepanel/fullStackRetention"
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
  initialFullStackControl?: RetainedFullStackControl | null
  persistFullStackControl?: (
    control: RetainedFullStackControl | null,
  ) => Promise<void>
  fullStackRecoveryError?: string | null
  onCreatePendingChange?: (pending: boolean) => void
}

type FullStackAnalysis = BuildTargetAnalysis & RepositoryAnalysis

// Discovery selects a candidate; the stable workspace below owns its job UI.
// Register before paint so a changed target never exposes the old Run button.
function FullStackSelection({
  analysis,
  onSelect,
}: {
  analysis: FullStackAnalysis
  onSelect: (analysis: FullStackAnalysis | null) => void
}) {
  useLayoutEffect(() => {
    onSelect(analysis)
    return () => onSelect(null)
  }, [analysis, onSelect])
  return null
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
  initialFullStackControl = null,
  persistFullStackControl,
  fullStackRecoveryError = null,
  onCreatePendingChange,
}: SidePanelAppProps) {
  const [retainedFullStackControl, setRetainedFullStackControl] =
    useState<RetainedFullStackControl | null>(initialFullStackControl)
  const [restoringFullStack, setRestoringFullStack] = useState(
    Boolean(
      initialFullStackControl &&
      !["stopped", "failed", "cancelled", "expired"].includes(
        initialFullStackControl.preview.status,
      ),
    ),
  )
  const [retentionError, setRetentionError] = useState(fullStackRecoveryError)
  const [selectedFullStackAnalysis, selectFullStackAnalysis] =
    useState<FullStackAnalysis | null>(null)
  const [fullStackCreatePending, setFullStackCreatePending] = useState(false)
  const handleCreatePendingChange = useCallback(
    (pending: boolean) => {
      setFullStackCreatePending(pending)
      onCreatePendingChange?.(pending)
    },
    [onCreatePendingChange],
  )
  const [detailsHost, setDetailsHost] = useState<HTMLDivElement | null>(null)
  const fullStackAnalysis =
    retainedFullStackControl?.analysis ?? selectedFullStackAnalysis
  // Only analysis details use a portal. The workspace and its iframe never
  // reparent or change keys when Create returns, analysis reloads, or targets change.
  const renderAnalysisDetails = useCallback(
    (details: ReactNode) =>
      detailsHost ? createPortal(details, detailsHost) : null,
    [detailsHost],
  )
  const updateRetainedFullStackPreview = useCallback(
    (preview: FullStackPreview | null) => {
      const next =
        preview && fullStackAnalysis
          ? { analysis: fullStackAnalysis, preview }
          : null
      setRetainedFullStackControl(next)
      setRestoringFullStack(false)
      if (persistFullStackControl)
        void persistFullStackControl(next).then(
          () => setRetentionError(null),
          () =>
            setRetentionError(
              "Preview controls could not be saved. Keep this panel open until you stop the preview.",
            ),
        )
    },
    [fullStackAnalysis, persistFullStackControl],
  )

  return (
    <main className="peephole-panel">
      <header className="peephole__header">
        <div>
          <p className="peephole__eyebrow">Repository analysis</p>
          <h1 className="peephole__title">Peephole</h1>
        </div>
      </header>

      <p className="peephole__action-note">
        This panel belongs to the repository opened with Peephole in this tab.
        Use the repository's Peephole button to switch context.
      </p>
      {retentionError && <p role="alert">{retentionError}</p>}
      {fullStackCreatePending && (
        <p role="status">
          Keep this panel open until the preview job ID is received.
        </p>
      )}

      {repository ? (
        <RepositoryAnalysisView
          fullStackCreatePending={fullStackCreatePending}
          hasRetainedFullStackPreview={Boolean(retainedFullStackControl)}
          loadRepositoryAnalysis={loadRepositoryAnalysis}
          loadBuildTargetAnalysis={loadBuildTargetAnalysis}
          loadRepositoryBranches={loadRepositoryBranches}
          loadRepositoryLiveDeployment={loadRepositoryLiveDeployment}
          repository={repository}
          renderAnalysisDetails={renderAnalysisDetails}
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
              ? (analysis) =>
                  retainedFullStackControl ? null : (
                    <FullStackSelection
                      analysis={analysis}
                      key={`fullstack-selection:${analysis.repository.repositoryId}:${analysis.repository.commitSha}:${analysis.target.sourceRoot}`}
                      onSelect={selectFullStackAnalysis}
                    />
                  )
              : undefined
          }
          renderPreviewControls={(analysis) => (
            <PreviewJobPanel
              analysis={analysis}
              configurationError={previewConfigurationError}
              connectGitHub={connectGitHub}
              key={`native:${analysis.repository.repositoryId}:${analysis.repository.commitSha}:${analysis.target.sourceRoot}`}
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
      {fullStackPreviewEnabled && fullStackAnalysis && (
        <>
          <p className="peephole__action-note">
            Full-stack controls: {fullStackAnalysis.repository.owner}/
            {fullStackAnalysis.repository.repo} at{" "}
            {fullStackAnalysis.repository.commitSha.slice(0, 7)}.
          </p>
          <FullStackPreviewPanel
            analysis={fullStackAnalysis}
            configurationError={previewConfigurationError}
            connectGitHub={connectGitHub}
            fullStackPreviewApi={fullStackPreviewApi}
            key={`fullstack:${fullStackAnalysis.repository.repositoryId}:${fullStackAnalysis.repository.commitSha}:${fullStackAnalysis.target.sourceRoot}`}
            onCreatePendingChange={handleCreatePendingChange}
            onRetainedPreviewChange={updateRetainedFullStackPreview}
            previewArtifactBaseDomain={previewArtifactBaseDomain}
            retainedPreview={retainedFullStackControl?.preview ?? null}
            restoringPreview={restoringFullStack}
          />
        </>
      )}
      <div className="peephole__analysis-details" ref={setDetailsHost} />
    </main>
  )
}
