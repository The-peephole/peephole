import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as tar from "tar"

import { isSafeEntryPath } from "../../../core/runner/archivePolicy"

export interface ExtractArchiveOptions {
  destinationDir: string
  maxEntryPathLength?: number
}

const UNSAFE_TAR_TYPES = new Set([
  "SymbolicLink",
  "Link",
  "CharacterDevice",
  "BlockDevice",
  "FIFO",
])

export async function extractArchiveToDirectory(
  data: Uint8Array,
  options: ExtractArchiveOptions,
): Promise<void> {
  const stagingDir = await mkdtemp(
    path.join(os.tmpdir(), "peephole-archive-"),
  )
  const archiveFile = path.join(stagingDir, "source.tar.gz")

  try {
    await writeFile(archiveFile, data)

    await tar.x({
      file: archiveFile,
      cwd: options.destinationDir,
      strip: 1,
      preservePaths: false,
      maxDecompressionRatio: 1_000,
      filter: (entryPath, entry) => {
        const type = "type" in entry ? entry.type : undefined

        if (type && UNSAFE_TAR_TYPES.has(type)) {
          return false
        }

        return isSafeEntryPath(
          entryPath,
          options.maxEntryPathLength ?? 4096,
        )
      },
    })
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}
