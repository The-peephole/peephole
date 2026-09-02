import {
  ANALYZER_VERSION,
  type RepositoryAnalysis,
  type RepositoryAnalysisLoader,
} from "../../types/analysis"
import type {
  RepositoryIdentity,
  RepositoryMetadata,
  RepositoryMetadataLoader,
} from "../../types/repository"
import type {
  KnownRepositoryFilesLoader,
  RepositoryFileSnapshot,
} from "../github/knownFiles"
import { analyzeRepository } from "./analyzeRepository"

interface KnownFilesSource {
  load(
    repository: RepositoryMetadata,
    signal?: AbortSignal,
  ): Promise<RepositoryFileSnapshot>
}

export class RepositoryAnalysisService {
  private readonly cache = new Map<string, RepositoryAnalysis>()

  constructor(
    private readonly loadRepositoryMetadata: RepositoryMetadataLoader,
    private readonly knownFiles: KnownFilesSource | KnownRepositoryFilesLoader,
  ) {}

  readonly load: RepositoryAnalysisLoader = async (
    repository: RepositoryIdentity,
    options = {},
  ) => {
    const metadata = await this.loadRepositoryMetadata(repository, options)
    const cacheKey = `${metadata.repositoryId}:${metadata.commitSha}:${ANALYZER_VERSION}`
    const cached = this.cache.get(cacheKey)

    if (cached) {
      return cached
    }

    const files = await this.knownFiles.load(metadata, options.signal)
    const analysis = analyzeRepository(metadata, files)
    this.cache.set(cacheKey, analysis)

    return analysis
  }

  clear(): void {
    this.cache.clear()
  }
}
