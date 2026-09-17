import type {
  RepositoryLiveDeployment,
  RepositoryLiveDeploymentLoader,
} from "../../types/deployment"
import type { RepositoryIdentity } from "../../types/repository"
import { getRepositoryKey } from "../../utils/githubUrl"

const DEFAULT_LIVE_DEPLOYMENT_TTL_MS = 45_000

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
  private readonly now: () => number

  constructor(
    private readonly source: LiveDeploymentSource,
    options: RepositoryLiveDeploymentCacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_LIVE_DEPLOYMENT_TTL_MS
    this.now = options.now ?? Date.now
  }

  readonly load: RepositoryLiveDeploymentLoader = async (
    repository,
    options = {},
  ) => {
    const key = getRepositoryKey(repository)
    const cached = this.entries.get(key)

    if (cached && cached.expiresAt > this.now()) {
      return cached.value
    }

    const value = await this.source.load(repository, options.signal)
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs })
    return value
  }

  clear(): void {
    this.entries.clear()
  }
}
