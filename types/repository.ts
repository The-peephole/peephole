export interface RepositoryIdentity {
  owner: string
  repo: string
}

export interface RepositoryMetadata extends RepositoryIdentity {
  repositoryId: number
  defaultBranch: string
  commitSha: string
  homepage: string | null
}

export interface RepositoryMetadataLoadOptions {
  signal?: AbortSignal
}

export type RepositoryMetadataLoader = (
  repository: RepositoryIdentity,
  options?: RepositoryMetadataLoadOptions,
) => Promise<RepositoryMetadata>
