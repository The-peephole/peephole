import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  resolveWorkspaceOutputRoot,
  resolveWorkspaceSourceRoot,
} from "../services/preview-worker/local/workspacePath"

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe("workspace target containment", () => {
  it("resolves only the selected target and target-local output", async () => {
    const root = await createWorkspace()
    await mkdir(path.join(root, "apps", "web", "dist"), { recursive: true })

    await expect(resolveWorkspaceSourceRoot(root, "apps/web")).resolves.toBe(
      path.join(root, "apps", "web"),
    )
    await expect(
      resolveWorkspaceOutputRoot(root, "apps/web", "dist"),
    ).resolves.toBe(path.join(root, "apps", "web", "dist"))
  })

  it.each(["../outside", "apps/../outside", "C:/outside", "apps\\web"])(
    "rejects unsafe source root %j",
    async (sourceRoot) => {
      const root = await createWorkspace()
      await expect(
        resolveWorkspaceSourceRoot(root, sourceRoot),
      ).rejects.toThrow("unsafe")
    },
  )

  it("rejects a symbolic-link segment before command or publish access", async () => {
    const root = await createWorkspace()
    const outside = await createWorkspace()
    await mkdir(path.join(outside, "dist"), { recursive: true })
    await mkdir(path.join(root, "apps"), { recursive: true })
    await symlink(outside, path.join(root, "apps", "web"), "junction")

    await expect(resolveWorkspaceSourceRoot(root, "apps/web")).rejects.toThrow(
      "symbolic link",
    )
    await expect(
      resolveWorkspaceOutputRoot(root, "apps/web", "dist"),
    ).rejects.toThrow("symbolic link")
  })
})

async function createWorkspace(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "peephole-target-test-"),
  )
  cleanup.push(directory)
  return directory
}
