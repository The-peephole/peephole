import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { ArchiveByteStore } from "../services/preview-worker/local/archiveByteStore"
import type {
  CommandRunner,
  CommandRunOptions,
} from "../services/preview-worker/local/commandRunner"
import { ExtractionState } from "../services/preview-worker/local/extractionState"
import type { LocalPreviewWorkspace } from "../services/preview-worker/local/localWorkspace"
import { NpmDependencyInstaller } from "../services/preview-worker/local/npmDependencyInstaller"
import type { BuildPlan } from "../types/preview"

const commitSha = "a".repeat(40)
const repository = {
  repositoryId: 1,
  owner: "acme",
  name: "web",
  commitSha,
}

describe("post-extraction ownership boundary", () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    )
  })

  it.each([
    ["root", ".", "static-v1"],
    ["nested static npm", "apps/web", "static-v2"],
  ] as const)(
    "normalizes the extracted tree before running npm ci for a %s sourceRoot",
    async (_label, sourceRoot, contractVersion) => {
      const rootDir = await mkdtemp(
        path.join(os.tmpdir(), "peephole-extraction-ownership-"),
      )
      roots.push(rootDir)
      const events: string[] = []
      const workspace: LocalPreviewWorkspace = {
        id: `job-${contractVersion}`,
        rootDir,
        remainingMs: () => 60_000,
        normalizeExtractedTree: async () => {
          events.push("normalize")
        },
        destroy: async () => undefined,
      }
      const store = new ArchiveByteStore()
      store.put(commitSha, new Uint8Array())
      const extraction = new ExtractionState(async (_data, options) => {
        events.push("extract")
        const target =
          sourceRoot === "."
            ? options.destinationDir
            : path.join(options.destinationDir, ...sourceRoot.split("/"))
        await mkdir(target, { recursive: true })
        await writeFile(path.join(target, "package-lock.json"), "{}")
      })
      const runner = new RecordingRunner(events)
      const installer = new NpmDependencyInstaller(store, extraction, runner)
      const plan: BuildPlan = {
        contractVersion,
        repository,
        sourceRoot,
        packageManager: "npm",
        installCommand: "npm ci",
        buildCommand: "npm run build",
        outputDirectory: "dist",
      }

      await installer.install(
        workspace,
        { compressedBytes: 0, entries: [] },
        plan,
      )

      expect(events).toEqual(["extract", "normalize", "run"])
      expect(runner.workingDirectories).toEqual([sourceRoot])
    },
  )
})

class RecordingRunner implements CommandRunner {
  readonly workingDirectories: Array<string | undefined> = []

  constructor(private readonly events: string[]) {}

  async run(
    _workspace: LocalPreviewWorkspace,
    _command: string,
    _args: string[],
    options: CommandRunOptions,
  ): Promise<void> {
    this.events.push("run")
    this.workingDirectories.push(options.workingDirectory)
  }
}
