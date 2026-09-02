import type { PackageManager } from "./analysis"

export type RunnablePackageManager = Exclude<PackageManager, "unknown">

export interface PreviewRepositoryRef {
  repositoryId: number
  owner: string
  name: string
  commitSha: string
}

export interface BuildPlan {
  contractVersion: string
  repository: PreviewRepositoryRef
  sourceRoot: "."
  packageManager: RunnablePackageManager
  installCommand: string | null
  buildCommand: string | null
  outputDirectory: string
}

export type PreviewJobStatus =
  | "queued"
  | "fetching"
  | "installing"
  | "building"
  | "publishing"
  | "ready"
  | "failed"
  | "cancelled"
  | "expired"

export type PreviewJobErrorCode =
  | "FETCH_FAILED"
  | "INSTALL_FAILED"
  | "BUILD_FAILED"
  | "PUBLISH_FAILED"
  | "RUNNER_TIMEOUT"
  | "RUNNER_UNAVAILABLE"
  | "ARTIFACT_UNAVAILABLE"

export interface PreviewArtifactReference {
  url: string
  expiresAt: string
}

export interface PreviewJob {
  id: string
  repository: PreviewRepositoryRef
  plan: BuildPlan
  cacheKey: string
  cacheStatus: "hit" | "miss"
  status: PreviewJobStatus
  artifact: PreviewArtifactReference | null
  errorCode: PreviewJobErrorCode | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
  expiresAt: string
}

export interface CreatePreviewJobRequest {
  repository: PreviewRepositoryRef
  contractVersion: string
}

export type PreviewApiErrorCode =
  | "INVALID_REQUEST"
  | "UNSUPPORTED_REPOSITORY"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INVALID_TRANSITION"
  | "INTERNAL_ERROR"

export interface PreviewRequester {
  subject: string
  ip: string
}

export interface QueuedPreviewJob {
  jobId: string
  repository: PreviewRepositoryRef
  plan: BuildPlan
  cacheKey: string
}
