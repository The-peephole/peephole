import type {
  RepositoryIdentity,
  RepositoryMetadata,
  RepositoryMetadataLoader,
} from "../../types/repository"
import { getRepositoryKey } from "../../utils/githubUrl"

const DEFAULT_CURRENT_REF_TTL_MS = 60_000

interface CurrentRefCacheEntry {
  commitKey: string
  expiresAt: number
}

interface RepositoryMetadataSource {
  getRepositoryMetadata(
    repository: RepositoryIdentity,
    signal?: AbortSignal,
  ): Promise<RepositoryMetadata>
}

export interface RepositoryMetadataCacheOptions {
  currentRefTtlMs?: number
  now?: () => number
}

export class RepositoryMetadataCache {
  private readonly currentRefs = new Map<string, CurrentRefCacheEntry>()
  private readonly commits = new Map<string, RepositoryMetadata>()
  private readonly currentRefTtlMs: number
  private readonly now: () => number

  constructor(
    private readonly source: RepositoryMetadataSource,
    options: RepositoryMetadataCacheOptions = {},
  ) {
    this.currentRefTtlMs = options.currentRefTtlMs ?? DEFAULT_CURRENT_REF_TTL_MS
    this.now = options.now ?? Date.now
  }

  readonly load: RepositoryMetadataLoader = async (
    repository,
    options = {},
  ) => {
    const repositoryKey = getRepositoryKey(repository)
    const currentRef = this.currentRefs.get(repositoryKey)

    if (currentRef && currentRef.expiresAt > this.now()) {
      const cached = this.commits.get(currentRef.commitKey)

      if (cached) {
        return cached
      }
    }

    const metadata = await this.source.getRepositoryMetadata(
      repository,
      options.signal,
    )
    const commitKey = `${metadata.repositoryId}:${metadata.commitSha}`

    this.commits.set(commitKey, metadata)
    this.currentRefs.set(repositoryKey, {
      commitKey,
      expiresAt: this.now() + this.currentRefTtlMs,
    })

    return metadata
  }

  clear(): void {
    this.currentRefs.clear()
    this.commits.clear()
  }
}
