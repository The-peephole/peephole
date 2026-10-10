import type {
  RepositoryLiveDeployment,
  RepositoryLiveDeploymentLoader,
} from "../../types/deployment"
import type { RepositoryIdentity } from "../../types/repository"
import { getRepositoryKey } from "../../utils/githubUrl"

const DEFAULT_LIVE_DEPLOYMENT_TTL_MS = 45_000
const DEFAULT_MAX_LIVE_DEPLOYMENTS = 64

interface LiveDeploymentCacheEntry {
  value: RepositoryLiveDeployment
  expiresAt: number
}

interface LiveDeploymentSource {
  load(
    repository: RepositoryIdentity,
    signal?: AbortSignal,
  ): Promise<RepositoryLiveDeployment>
}

export interface RepositoryLiveDeploymentCacheOptions {
  ttlMs?: number
  maxEntries?: number
  now?: () => number
}

/**
 * Short-TTL cache for mutable current-deployment state, keyed by repository
 * identity only -- never by commit SHA or branch. This is deliberately
 * separate from `RepositoryAnalysisService`'s immutable
 * `repositoryId:commitSha:analyzerVersion` cache: a repository's live
 * deployment can change independently of any particular commit, so folding
 * it into that immutable cache would leak stale live-deployment state across
 * builds, or across commits that reuse a cached analysis.
 */
export class RepositoryLiveDeploymentCache {
  private readonly entries = new Map<string, LiveDeploymentCacheEntry>()
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(
    private readonly source: LiveDeploymentSource,
    options: RepositoryLiveDeploymentCacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_LIVE_DEPLOYMENT_TTL_MS
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_LIVE_DEPLOYMENTS
    this.now = options.now ?? Date.now
  }

  readonly load: RepositoryLiveDeploymentLoader = async (
    repository,
    options = {},
  ) => {
    const key = getRepositoryKey(repository)
    const cached = this.entries.get(key)

    if (cached && cached.expiresAt > this.now()) {
      this.entries.delete(key)
      this.entries.set(key, cached)
      return cached.value
    }

    const value = await this.source.load(repository, options.signal)
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs })
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined
      if (oldestKey === undefined) break
      this.entries.delete(oldestKey)
    }
    return value
  }

  clear(): void {
    this.entries.clear()
  }
}
