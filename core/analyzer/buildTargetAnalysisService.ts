import {
  TARGET_ANALYZER_VERSION,
  type BuildTargetAnalysis,
  type BuildTargetAnalysisLoader,
} from "../../types/analysis"
import type { RepositoryMetadata } from "../../types/repository"
import type { PreviewTarget } from "../../types/target"
import type { RepositoryFileSnapshot } from "../github/knownFiles"
import {
  isSafePreviewSourceRoot,
  previewTargetKey,
} from "../preview/sourceRoot"
import { analyzeBuildTarget } from "./analyzeBuildTarget"

interface TargetKnownFilesSource {
  load(
    repository: RepositoryMetadata,
    target: PreviewTarget,
    signal?: AbortSignal,
  ): Promise<RepositoryFileSnapshot>
}

export class BuildTargetAnalysisService {
  private readonly cache = new Map<string, BuildTargetAnalysis>()

  constructor(private readonly knownFiles: TargetKnownFilesSource) {}

  readonly load: BuildTargetAnalysisLoader = async (
    repository,
    target,
    options = {},
  ) => {
    if (!isSafePreviewSourceRoot(target.sourceRoot)) {
      throw new Error("Preview target source root is invalid.")
    }

    const cacheKey = `${previewTargetKey(
      repository.repositoryId,
      repository.commitSha,
      target.sourceRoot,
    )}:${TARGET_ANALYZER_VERSION}`
    const cached = this.cache.get(cacheKey)
    if (cached) return cached

    const files = await this.knownFiles.load(repository, target, options.signal)
    const analysis = analyzeBuildTarget(repository, target, files)
    this.cache.set(cacheKey, analysis)
    return analysis
  }

  clear(): void {
    this.cache.clear()
  }
}
