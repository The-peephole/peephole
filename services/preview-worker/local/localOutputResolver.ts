import { lstat, readdir } from "node:fs/promises"
import path from "node:path"

import { isSafeEntryPath } from "../../../core/runner/archivePolicy"
import type { BuildPlan } from "../../../types/preview"
import type { ArchiveEntry, ResolvedOutput } from "../../../types/runner"
import type { OutputResolver, PreviewWorkspace } from "../ports"
import type { ArchiveByteStore } from "./archiveByteStore"
import type { ExtractionState } from "./extractionState"
import type { LocalOutputLocationRegistry } from "./localOutputLocationRegistry"
import { asLocalWorkspace } from "./localWorkspace"

export class LocalOutputResolver implements OutputResolver {
  constructor(
    private readonly byteStore: ArchiveByteStore,
    private readonly extraction: ExtractionState,
    private readonly locations: LocalOutputLocationRegistry,
  ) {}

  async resolve(
    workspace: PreviewWorkspace,
    plan: BuildPlan,
  ): Promise<ResolvedOutput> {
    const local = asLocalWorkspace(workspace)

    // Static plans have no install/build phase, so nothing has extracted
    // the archive yet by the time we reach publishing. Idempotent no-op for
    // npm/vite plans, which already extracted during install.
    await this.extraction.ensureExtracted(
      local,
      plan.repository.commitSha,
      this.byteStore,
    )

    const outputDir = path.join(local.rootDir, plan.outputDirectory)
    const entries = await walkDirectory(outputDir, outputDir)

    this.locations.set(local.id, outputDir)

    return { entries }
  }
}

async function walkDirectory(
  root: string,
  currentDir: string,
): Promise<ArchiveEntry[]> {
  const dirents = await readdir(currentDir, { withFileTypes: true })
  const entries: ArchiveEntry[] = []

  for (const dirent of dirents) {
    const absolutePath = path.join(currentDir, dirent.name)
    const relativePath = path
      .relative(root, absolutePath)
      .split(path.sep)
      .join("/")

    if (!isSafeEntryPath(relativePath, 4096)) {
      throw new Error(`Build output contains an unsafe path: ${relativePath}`)
    }

    const stats = await lstat(absolutePath)

    if (stats.isSymbolicLink()) {
      throw new Error(`Build output contains a symlink: ${relativePath}`)
    }

    if (stats.isDirectory()) {
      entries.push(...(await walkDirectory(root, absolutePath)))
      continue
    }

    if (!stats.isFile()) {
      throw new Error(
        `Build output contains an unsupported entry type: ${relativePath}`,
      )
    }

    entries.push({
      path: relativePath,
      bytes: stats.size,
      isSymlink: false,
    })
  }

  return entries
}
