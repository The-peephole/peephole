import { RepositoryAnalysisView } from "../../components/RepositoryAnalysisView"
import type { RepositoryAnalysisLoader } from "../../types/analysis"
import type { RepositoryIdentity } from "../../types/repository"

interface SidePanelAppProps {
  repository: RepositoryIdentity | null
  loadRepositoryAnalysis: RepositoryAnalysisLoader
}

export function SidePanelApp({
  repository,
  loadRepositoryAnalysis,
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
