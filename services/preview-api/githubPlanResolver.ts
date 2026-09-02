import { analyzeRepository } from "../../core/analyzer/analyzeRepository"
import { createBuildPlanFromAnalysis } from "../../core/preview/buildPlan"
import type { GitHubClient } from "../../core/github/client"
import type { KnownRepositoryFilesLoader } from "../../core/github/knownFiles"
import { PREVIEW_CONTRACT_VERSION } from "../../types/analysis"
import type { BuildPlan, PreviewRepositoryRef } from "../../types/preview"
import type { PreviewPlanResolver } from "./ports"

export class GitHubPreviewPlanResolver implements PreviewPlanResolver {
  constructor(
    private readonly github: GitHubClient,
    private readonly knownFiles: KnownRepositoryFilesLoader,
  ) {}

  async resolve(
    repository: PreviewRepositoryRef,
    contractVersion: string,
  ): Promise<BuildPlan | null> {
    if (contractVersion !== PREVIEW_CONTRACT_VERSION) {
      return null
    }

    const metadata = await this.github.getRepositoryMetadataAtCommit(repository)
    const files = await this.knownFiles.load(metadata)
    const analysis = analyzeRepository(metadata, files)

    if (
      analysis.preview.mode !== "native-static-build" ||
      !isImplementedRunnerTarget(
        analysis.technologies.framework,
        analysis.packageManager,
      )
    ) {
      return null
    }

    return createBuildPlanFromAnalysis(analysis)
  }
}

function isImplementedRunnerTarget(
  framework: string,
  packageManager: string,
): boolean {
  return (
    (framework === "static" && packageManager === "none") ||
    (framework === "react-vite" && packageManager === "npm")
  )
}
