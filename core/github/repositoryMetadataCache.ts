import type {
  RepositoryIdentity,
  RepositoryMetadata,
  RepositoryMetadataLoader,
} from "../../types/repository"
import { getRepositoryKey } from "../../utils/githubUrl"
import { getRepositoryRefCacheKey } from "./repositoryRef"

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
  getRepositoryMetadataAtBranch(
    repository: RepositoryIdentity,
    branchName: string,
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

  readonly load: RepositoryMetadataLoader = async (target, options = {}) => {
    const repositoryKey = getRepositoryKey(target.repository)
    const refKey = getRepositoryRefCacheKey(repositoryKey, target.ref)
    const currentRef = this.currentRefs.get(refKey)

    if (currentRef && currentRef.expiresAt > this.now()) {
      const cached = this.commits.get(currentRef.commitKey)

      if (cached) {
        return cached
      }
    }

    const metadata =
      target.ref.kind === "default"
        ? await this.source.getRepositoryMetadata(
            target.repository,
            options.signal,
          )
        : await this.source.getRepositoryMetadataAtBranch(
            target.repository,
            target.ref.name,
            options.signal,
          )
    const commitKey = `${metadata.repositoryId}:${metadata.commitSha.toLowerCase()}`

    this.commits.set(commitKey, metadata)
    this.currentRefs.set(refKey, {
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
