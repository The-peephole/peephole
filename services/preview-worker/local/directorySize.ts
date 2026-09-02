import { lstat, readdir } from "node:fs/promises"
import path from "node:path"

/**
 * Walks a directory and returns true as soon as the cumulative size of
 * regular files strictly exceeds `maxBytes`, without finishing the walk.
 * Symlinks are not followed (their target is irrelevant to disk usage of
 * this tree) but their own directory-entry size, if any, is not counted
 * either -- this function measures usage, `archivePolicy` handles rejecting
 * symlinks outright.
 */
export async function directorySizeExceeds(
  dir: string,
  maxBytes: number,
): Promise<boolean> {
  let total = 0

  async function walk(currentDir: string): Promise<boolean> {
    const dirents = await readdir(currentDir, { withFileTypes: true })

    for (const dirent of dirents) {
      const absolutePath = path.join(currentDir, dirent.name)
      const stats = await lstat(absolutePath)

      if (stats.isSymbolicLink()) {
        continue
      }

      if (stats.isDirectory()) {
        if (await walk(absolutePath)) {
          return true
        }
        continue
      }

      total += stats.size

      if (total > maxBytes) {
        return true
      }
    }

    return false
  }

  return walk(dir)
}
