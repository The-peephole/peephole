import {
  ANALYZER_VERSION,
  type RepositoryAnalysis,
  type RepositoryAnalysisLoader,
} from "../../types/analysis"
import type {
  RepositoryMetadata,
  RepositoryMetadataLoader,
} from "../../types/repository"
import type { RepositoryStructure } from "../../types/structure"
import type {
  KnownRepositoryFilesLoader,
  RepositoryFileSnapshot,
} from "../github/knownFiles"
import type { RepositoryStructureLoader } from "../github/repositoryStructureLoader"
import { analyzeRepository } from "./analyzeRepository"

interface KnownFilesSource {
  load(
    repository: RepositoryMetadata,
    signal?: AbortSignal,
  ): Promise<RepositoryFileSnapshot>
}

interface StructureSource {
  load(
    repository: RepositoryMetadata,
    files: RepositoryFileSnapshot,
    signal?: AbortSignal,
  ): Promise<RepositoryStructure>
}

export class RepositoryAnalysisService {
  private readonly cache = new Map<string, RepositoryAnalysis>()

  constructor(
    private readonly loadRepositoryMetadata: RepositoryMetadataLoader,
    private readonly knownFiles: KnownFilesSource | KnownRepositoryFilesLoader,
    private readonly structure: StructureSource | RepositoryStructureLoader,
  ) {}

  readonly load: RepositoryAnalysisLoader = async (target, options = {}) => {
    const metadata = await this.loadRepositoryMetadata(target, options)
    const cacheKey = `${metadata.repositoryId}:${metadata.commitSha.toLowerCase()}:${ANALYZER_VERSION}`
    const cached = this.cache.get(cacheKey)

    if (cached) {
      return cached
    }

    const files = await this.knownFiles.load(metadata, options.signal)
    const structure = await this.structure.load(metadata, files, options.signal)
    const analysis = analyzeRepository(metadata, files, structure)
    this.cache.set(cacheKey, analysis)

    return analysis
  }

  clear(): void {
    this.cache.clear()
  }
}
