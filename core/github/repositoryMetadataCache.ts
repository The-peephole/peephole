import type {
  RepositoryIdentity,
  RepositoryMetadata,
  RepositoryMetadataLoader,
} from "../../types/repository"
import { getRepositoryKey } from "../../utils/githubUrl"
import { getRepositoryRefCacheKey } from "./repositoryRef"

const DEFAULT_CURRENT_REF_TTL_MS = 60_000
const DEFAULT_MAX_CURRENT_REFS = 128
const DEFAULT_MAX_COMMITS = 128

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
  maxCurrentRefs?: number
  maxCommits?: number
  now?: () => number
}

export class RepositoryMetadataCache {
  private readonly currentRefs = new Map<string, CurrentRefCacheEntry>()
  private readonly commits = new Map<string, RepositoryMetadata>()
  private readonly currentRefTtlMs: number
  private readonly maxCurrentRefs: number
  private readonly maxCommits: number
  private readonly now: () => number

  constructor(
    private readonly source: RepositoryMetadataSource,
    options: RepositoryMetadataCacheOptions = {},
  ) {
    this.currentRefTtlMs = options.currentRefTtlMs ?? DEFAULT_CURRENT_REF_TTL_MS
    this.maxCurrentRefs = options.maxCurrentRefs ?? DEFAULT_MAX_CURRENT_REFS
    this.maxCommits = options.maxCommits ?? DEFAULT_MAX_COMMITS
    this.now = options.now ?? Date.now
  }

  readonly load: RepositoryMetadataLoader = async (target, options = {}) => {
    const repositoryKey = getRepositoryKey(target.repository)
    const refKey = getRepositoryRefCacheKey(repositoryKey, target.ref)
    const currentRef = this.currentRefs.get(refKey)

    if (currentRef && currentRef.expiresAt > this.now()) {
      const cached = this.commits.get(currentRef.commitKey)

      if (cached) {
        this.touch(this.currentRefs, refKey, currentRef)
        this.touch(this.commits, currentRef.commitKey, cached)
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

    this.setBounded(this.commits, commitKey, metadata, this.maxCommits)
    this.setBounded(
      this.currentRefs,
      refKey,
      {
        commitKey,
        expiresAt: this.now() + this.currentRefTtlMs,
      },
      this.maxCurrentRefs,
    )

    return metadata
  }

  clear(): void {
    this.currentRefs.clear()
    this.commits.clear()
  }

  private touch<T>(cache: Map<string, T>, key: string, value: T): void {
    cache.delete(key)
    cache.set(key, value)
  }

  private setBounded<T>(
    cache: Map<string, T>,
    key: string,
    value: T,
    maxEntries: number,
  ): void {
    if (maxEntries <= 0) return
    this.touch(cache, key, value)

    while (cache.size > maxEntries) {
      const oldestKey = cache.keys().next().value as string | undefined
      if (oldestKey === undefined) break
      cache.delete(oldestKey)
    }
  }
}
