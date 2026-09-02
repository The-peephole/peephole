import { extractArchiveToDirectory } from "./archiveExtractor"
import type { ArchiveByteStore } from "./archiveByteStore"
import type { LocalPreviewWorkspace } from "./localWorkspace"

/**
 * The static-HTML golden path never calls DependencyInstaller (there is no
 * install command), so extraction must also be reachable from
 * LocalOutputResolver. Both call `ensureExtracted` for the same workspace;
 * whichever runs first performs the real extraction and the other is a
 * no-op, without writing an extraction marker into the published tree.
 */
export class ExtractionState {
  private readonly extracted = new Set<string>()

  constructor(
    private readonly extract: typeof extractArchiveToDirectory = extractArchiveToDirectory,
  ) {}

  async ensureExtracted(
    workspace: LocalPreviewWorkspace,
    commitSha: string,
    byteStore: ArchiveByteStore,
  ): Promise<void> {
    if (this.extracted.has(workspace.id)) {
      return
    }

    const data = byteStore.take(commitSha)
    await this.extract(data, { destinationDir: workspace.rootDir })
    this.extracted.add(workspace.id)
  }
}
