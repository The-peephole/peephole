import type { BuildPlan, PreviewRepositoryRef } from "../../types/preview"
import type { FetchedArchive, ResolvedOutput } from "../../types/runner"

export interface PreviewWorkspace {
  readonly id: string
  destroy(): Promise<void>
}

export interface SandboxProvisioner {
  allocate(jobId: string): Promise<PreviewWorkspace>
}

export interface SourceArchiveFetcher {
  fetch(repository: PreviewRepositoryRef): Promise<FetchedArchive>
}

export interface DependencyInstaller {
  install(
    workspace: PreviewWorkspace,
    archive: FetchedArchive,
    plan: BuildPlan,
  ): Promise<void>
}

export interface BuildExecutor {
  build(workspace: PreviewWorkspace, plan: BuildPlan): Promise<void>
}

export interface OutputResolver {
  resolve(workspace: PreviewWorkspace, plan: BuildPlan): Promise<ResolvedOutput>
}

export interface PublishedArtifact {
  artifactId: string
}

export interface ArtifactPublisher {
  publish(jobId: string, output: ResolvedOutput): Promise<PublishedArtifact>
}
