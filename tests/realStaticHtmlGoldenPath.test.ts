import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { PreviewControlPlane } from "../services/preview-api/controlPlane"
import {
  FixedWindowPreviewQuota,
  HmacPreviewArtifactSigner,
  InMemoryPreviewArtifactCache,
  InMemoryPreviewJobStore,
  InMemoryPreviewQueue,
} from "../services/preview-api/inMemoryAdapters"
import { ArchiveByteStore } from "../services/preview-worker/local/archiveByteStore"
import { ExtractionState } from "../services/preview-worker/local/extractionState"
import { GitHubCommitArchiveFetcher } from "../services/preview-worker/local/githubCommitArchiveFetcher"
import { HostCommandRunner } from "../services/preview-worker/local/hostCommandRunner"
import { LocalArtifactPublisher } from "../services/preview-worker/local/localArtifactPublisher"
import { LocalDevSandboxProvisioner } from "../services/preview-worker/local/localDevSandboxProvisioner"
import { LocalOutputLocationRegistry } from "../services/preview-worker/local/localOutputLocationRegistry"
import { LocalOutputResolver } from "../services/preview-worker/local/localOutputResolver"
import { NpmBuildExecutor } from "../services/preview-worker/local/npmBuildExecutor"
import { NpmDependencyInstaller } from "../services/preview-worker/local/npmDependencyInstaller"
import { PreviewJobWorker } from "../services/preview-worker/worker"
import type { BuildPlan, PreviewRequester } from "../types/preview"

// Real, public, and extremely stable: GitHub's own "fork a repo" tutorial
// fixture. Pinned to a specific commit so this test never depends on the
// repository's current HEAD.
const repository = {
  repositoryId: 1_300_192,
  owner: "octocat",
  name: "Spoon-Knife",
  commitSha: "d0dd1f61b33d64e29d8bc1372a94ef6a2fee76a9",
}

const staticPlan: BuildPlan = {
  contractVersion: "static-v1",
  repository,
  sourceRoot: ".",
  packageManager: "none",
  installCommand: null,
  buildCommand: null,
  outputDirectory: ".",
}

const requester: PreviewRequester = { subject: "user-1", ip: "203.0.113.10" }

describe.skipIf(!process.env.PEEPHOLE_REAL_NETWORK_TESTS)(
  "real static HTML golden path (network)",
  () => {
    let storageDir: string

    beforeAll(async () => {
      storageDir = await mkdtemp(
        path.join(os.tmpdir(), "peephole-static-artifact-"),
      )
    })

    afterAll(async () => {
      await rm(storageDir, { recursive: true, force: true })
    })

    it(
      "fetches a real commit archive, extracts it in a real sandbox directory, and publishes real files",
      async () => {
        const queue = new InMemoryPreviewQueue()
        const control = new PreviewControlPlane(
          { resolve: async () => staticPlan },
          new InMemoryPreviewJobStore(),
          queue,
          new InMemoryPreviewArtifactCache(),
          new HmacPreviewArtifactSigner(
            "peephole.run",
            "test-signing-secret-with-at-least-32-bytes",
          ),
          new FixedWindowPreviewQuota(),
          { runnerVersion: "runner-v1" },
        )

        const created = await control.create(
          { repository, contractVersion: "static-v1" },
          "request-0000000001",
          requester,
        )

        const byteStore = new ArchiveByteStore()
        const extraction = new ExtractionState()
        const locations = new LocalOutputLocationRegistry()
        const commandRunner = new HostCommandRunner()

        const worker = new PreviewJobWorker(
          control,
          new GitHubCommitArchiveFetcher(byteStore),
          new LocalDevSandboxProvisioner(),
          new NpmDependencyInstaller(byteStore, extraction, commandRunner),
          new NpmBuildExecutor(commandRunner),
          new LocalOutputResolver(byteStore, extraction, locations),
          new LocalArtifactPublisher(locations, { storageDir }),
        )

        const queuedJob = queue.dequeue()
        if (!queuedJob) throw new Error("expected a queued job")

        await worker.run(queuedJob)

        const job = await control.get(created.job.id, requester)
        expect(job.status).toBe("ready")
        expect(job.artifact?.url).toContain(created.job.id)

        const artifactId = job.artifact?.url.match(/artifacts\/([^/]+)\//)?.[1]
        if (!artifactId) throw new Error("expected an artifact id in the URL")

        const publishedIndex = await readFile(
          path.join(storageDir, artifactId, "index.html"),
          "utf8",
        )
        expect(publishedIndex).toContain("<!DOCTYPE html>")

        const publishedStyles = await readFile(
          path.join(storageDir, artifactId, "styles.css"),
          "utf8",
        )
        expect(publishedStyles.length).toBeGreaterThan(0)
      },
      30_000,
    )
  },
)
