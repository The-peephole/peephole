import { analyzeBuildTarget } from "../../core/analyzer/analyzeBuildTarget"
import { analyzeRepository } from "../../core/analyzer/analyzeRepository"
import {
  createBuildPlanFromAnalysis,
  createBuildPlanFromTargetAnalysis,
} from "../../core/preview/buildAdapters"
import type { GitHubClient } from "../../core/github/client"
import {
  KnownRepositoryFilesLoader,
  type RepositoryFileSnapshot,
} from "../../core/github/knownFiles"
import { RepositoryStructureLoader } from "../../core/github/repositoryStructureLoader"
import { TargetKnownFilesLoader } from "../../core/github/targetKnownFiles"
import { isSafePreviewSourceRoot } from "../../core/preview/sourceRoot"
import {
  LEGACY_PREVIEW_CONTRACT_VERSION,
  PREVIEW_CONTRACT_VERSION,
} from "../../types/analysis"
import type { BuildPlan, PreviewRepositoryRef } from "../../types/preview"
import type { RepositoryMetadata } from "../../types/repository"
import type { PreviewTarget } from "../../types/target"
import type { PreviewPlanResolver } from "./ports"

interface KnownFilesLoader {
  load(repository: RepositoryMetadata): Promise<RepositoryFileSnapshot>
}

export class GitHubPreviewPlanResolver implements PreviewPlanResolver {
  private readonly structure: RepositoryStructureLoader
  private readonly targetFiles: TargetKnownFilesLoader

  constructor(
    private readonly github: GitHubClient,
    private readonly knownFiles: KnownFilesLoader = new KnownRepositoryFilesLoader(
      github,
    ),
    structure = new RepositoryStructureLoader(github),
    targetFiles = new TargetKnownFilesLoader(github),
  ) {
    this.structure = structure
    this.targetFiles = targetFiles
  }

  async resolve(
    repository: PreviewRepositoryRef,
    contractVersion: string,
    target: PreviewTarget = { sourceRoot: "." },
  ): Promise<BuildPlan | null> {
    if (
      !isSafePreviewSourceRoot(target.sourceRoot) ||
      (contractVersion !== PREVIEW_CONTRACT_VERSION &&
        contractVersion !== LEGACY_PREVIEW_CONTRACT_VERSION) ||
      (contractVersion === LEGACY_PREVIEW_CONTRACT_VERSION &&
        target.sourceRoot !== ".")
    ) {
      return null
    }

    const metadata = await this.github.getRepositoryMetadataAtCommit(repository)
    const rootFiles = await this.knownFiles.load(metadata)

    if (target.sourceRoot === ".") {
      const analysis = analyzeRepository(metadata, rootFiles)
      analysis.preview.contractVersion = contractVersion
      return createBuildPlanFromAnalysis(analysis)
    }

    const structure = await this.structure.load(metadata, rootFiles)
    const authorized = structure.projects.some(
      (candidate) =>
        !candidate.isRoot &&
        candidate.role === "project-candidate" &&
        candidate.path === target.sourceRoot,
    )
    if (!authorized) return null

    const files = await this.targetFiles.load(metadata, target)
    const analysis = analyzeBuildTarget(
      metadata,
      target,
      files,
      contractVersion,
    )
    return createBuildPlanFromTargetAnalysis(analysis)
  }
}
