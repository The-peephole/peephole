import { randomUUID } from "node:crypto"
import { copyFile, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { isSafeEntryPath } from "../../../core/runner/archivePolicy"
import type { ResolvedOutput } from "../../../types/runner"
import type { ArtifactPublisher, PublishedArtifact } from "../ports"
import type { LocalOutputLocationRegistry } from "./localOutputLocationRegistry"

export interface LocalArtifactPublisherOptions {
  storageDir?: string
}

/**
 * Stands in for the real artifact store/CDN. Copies validated output files
 * into a local directory and hands back an opaque id -- no HTTP serving,
 * headers, or expiry sweep. `HmacPreviewArtifactSigner` (Milestone 4)
 * already produces the signed, expiring URL from that id.
 */
export class LocalArtifactPublisher implements ArtifactPublisher {
  private readonly storageDir: string

  constructor(
    private readonly locations: LocalOutputLocationRegistry,
    options: LocalArtifactPublisherOptions = {},
  ) {
    this.storageDir =
      options.storageDir ?? path.join(os.tmpdir(), "peephole-dev-artifacts")
  }

  async publish(
    jobId: string,
    output: ResolvedOutput,
  ): Promise<PublishedArtifact> {
    const sourceDir = this.locations.take(jobId)
    const artifactId = `artifact-${jobId}-${randomUUID()}`
    const destinationDir = path.join(this.storageDir, artifactId)

    for (const entry of output.entries) {
      if (!isSafeEntryPath(entry.path, 4096)) {
        throw new Error(`Refusing to publish unsafe entry path: ${entry.path}`)
      }

      const source = path.join(sourceDir, entry.path)
      const destination = path.join(destinationDir, entry.path)
      await mkdir(path.dirname(destination), { recursive: true })
      await copyFile(source, destination)
    }

    return { artifactId }
  }
}
