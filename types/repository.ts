export interface RepositoryIdentity {
  owner: string
  repo: string
}

export type RepositoryRefSelection =
  { kind: "default" } | { kind: "branch"; name: string }

export interface RepositoryRevisionTarget {
  repository: RepositoryIdentity
  ref: RepositoryRefSelection
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
  target: RepositoryRevisionTarget,
  options?: RepositoryMetadataLoadOptions,
) => Promise<RepositoryMetadata>

export interface RepositoryBranchList {
  defaultBranch: string
  branches: string[]
  truncated: boolean
}

export interface RepositoryBranchesLoadOptions {
  signal?: AbortSignal
}

export type RepositoryBranchesLoader = (
  repository: RepositoryIdentity,
  options?: RepositoryBranchesLoadOptions,
) => Promise<RepositoryBranchList>
