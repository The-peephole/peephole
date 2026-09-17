import {
  ANALYZER_VERSION,
  type RepositoryAnalysis,
  type RepositoryAnalysisLoader,
} from "../../types/analysis"
import type { BackendDetection } from "../../types/backend"
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

interface BackendSource {
  load(
    repository: RepositoryMetadata,
    candidatePaths: readonly string[],
    signal?: AbortSignal,
  ): Promise<BackendDetection>
}

const BACKEND_DISCOVERY_UNAVAILABLE: BackendDetection = {
  status: "not-detected",
  candidates: [],
  evidence: [],
  warnings: [
    "Nested backend candidate discovery failed and was skipped for this analysis.",
  ],
  complete: false,
  truncated: false,
}

export class RepositoryAnalysisService {
  private readonly cache = new Map<string, RepositoryAnalysis>()

  constructor(
    private readonly loadRepositoryMetadata: RepositoryMetadataLoader,
    private readonly knownFiles: KnownFilesSource | KnownRepositoryFilesLoader,
    private readonly structure: StructureSource | RepositoryStructureLoader,
    private readonly backend: BackendSource,
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
    const nestedCandidatePaths = structure.projects
      .filter((project) => !project.isRoot)
      .map((project) => project.path)
    const nestedBackend = await this.loadNestedBackend(
      metadata,
      nestedCandidatePaths,
      options.signal,
    )
    const analysis = analyzeRepository(
      metadata,
      files,
      structure,
      nestedBackend,
    )
    this.cache.set(cacheKey, analysis)

    return analysis
  }

  clear(): void {
    this.cache.clear()
  }

  /**
   * Nested backend discovery is optional, best-effort evidence: its failure
   * must never fail repository analysis (and therefore never disable Build
   * Preview for the selected frontend target). Only cancellation propagates.
   */
  private async loadNestedBackend(
    repository: RepositoryMetadata,
    candidatePaths: readonly string[],
    signal?: AbortSignal,
  ): Promise<BackendDetection> {
    try {
      return await this.backend.load(repository, candidatePaths, signal)
    } catch (error) {
      if (isAbortError(error)) throw error
      return BACKEND_DISCOVERY_UNAVAILABLE
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}
