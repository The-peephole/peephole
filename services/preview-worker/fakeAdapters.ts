import type { BuildPlan, PreviewRepositoryRef } from "../../types/preview"
import type { FetchedArchive, ResolvedOutput } from "../../types/runner"
import type {
  ArtifactPublisher,
  BuildExecutor,
  DependencyInstaller,
  OutputResolver,
  PreviewWorkspace,
  PublishedArtifact,
  SandboxProvisioner,
  SourceArchiveFetcher,
} from "./ports"

export class FakeSandboxProvisioner implements SandboxProvisioner {
  readonly allocatedIds: string[] = []
  readonly destroyedIds: string[] = []
  private readonly active = new Set<string>()

  constructor(private readonly allocationFailure: Error | null = null) {}

  async allocate(jobId: string): Promise<PreviewWorkspace> {
    if (this.allocationFailure) {
      throw this.allocationFailure
    }

    const id = `workspace-${jobId}`
    this.active.add(id)
    this.allocatedIds.push(id)

    return {
      id,
      destroy: async () => {
        this.active.delete(id)
        this.destroyedIds.push(id)
      },
    }
  }

  get activeCount(): number {
    return this.active.size
  }
}

export class FakeSourceArchiveFetcher implements SourceArchiveFetcher {
  private readonly archivesByCommit = new Map<string, FetchedArchive | Error>()

  setArchive(commitSha: string, archive: FetchedArchive | Error): void {
    this.archivesByCommit.set(commitSha.toLowerCase(), archive)
  }

  async fetch(repository: PreviewRepositoryRef): Promise<FetchedArchive> {
    const result = this.archivesByCommit.get(repository.commitSha.toLowerCase())

    if (result instanceof Error) {
      throw result
    }

    if (!result) {
      throw new Error(
        `No fake archive registered for commit ${repository.commitSha}.`,
      )
    }

    return result
  }
}

export class FakeDependencyInstaller implements DependencyInstaller {
  readonly calls: BuildPlan[] = []

  constructor(private readonly failure: Error | null = null) {}

  async install(
    _workspace: PreviewWorkspace,
    _archive: FetchedArchive,
    plan: BuildPlan,
  ): Promise<void> {
    this.calls.push(plan)

    if (this.failure) {
      throw this.failure
    }
  }
}

export class FakeBuildExecutor implements BuildExecutor {
  readonly calls: BuildPlan[] = []

  constructor(private readonly failure: Error | null = null) {}

  async build(_workspace: PreviewWorkspace, plan: BuildPlan): Promise<void> {
    this.calls.push(plan)

    if (this.failure) {
      throw this.failure
    }
  }
}

export class FakeOutputResolver implements OutputResolver {
  constructor(private readonly output: ResolvedOutput | Error) {}

  async resolve(): Promise<ResolvedOutput> {
    if (this.output instanceof Error) {
      throw this.output
    }

    return this.output
  }
}

export class FakeArtifactPublisher implements ArtifactPublisher {
  readonly calls: Array<{ jobId: string; output: ResolvedOutput }> = []
  private sequence = 0

  constructor(private readonly failure: Error | null = null) {}

  async publish(
    jobId: string,
    output: ResolvedOutput,
  ): Promise<PublishedArtifact> {
    this.calls.push({ jobId, output })

    if (this.failure) {
      throw this.failure
    }

    this.sequence += 1
    return { artifactId: `artifact-${jobId}-${this.sequence}` }
  }
}
