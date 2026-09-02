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

// A minimal, trusted fixture authored for this project and pushed to a
// dedicated public repo (see services/preview-worker README notes below):
// https://github.com/ppsssj/peephole-fixture-vite-react
//
// DEVELOPMENT PROOF, NOT A PRODUCTION-SAFE RUN: `npm ci` and `npm run build`
// execute directly on this host via HostCommandRunner/LocalDevSandboxProvisioner
// with no gVisor sandbox, no resource limits, and no network restriction.
// This is only safe here because the fixture's content is our own and
// small. Never point this wiring at arbitrary third-party repositories.
const repository = {
  repositoryId: 1_354_475_085,
  owner: "ppsssj",
  name: "peephole-fixture-vite-react",
  commitSha: "d1ac2e71550484b5072de243b4dbf754367ed045",
}

const vitePlan: BuildPlan = {
  contractVersion: "static-v1",
  repository,
  sourceRoot: ".",
  packageManager: "npm",
  installCommand: "npm ci",
  buildCommand: "npm run build",
  outputDirectory: "dist",
}

const requester: PreviewRequester = { subject: "user-1", ip: "203.0.113.10" }

describe.skipIf(!process.env.PEEPHOLE_REAL_NETWORK_TESTS)(
  "real Vite+React golden path (network, unsandboxed development proof)",
  () => {
    let storageDir: string

    beforeAll(async () => {
      storageDir = await mkdtemp(
        path.join(os.tmpdir(), "peephole-vite-artifact-"),
      )
    })

    afterAll(async () => {
      await rm(storageDir, { recursive: true, force: true })
    })

    it(
      "fetches the real commit, runs real npm ci + npm run build unsandboxed, and publishes real dist output",
      async () => {
        const queue = new InMemoryPreviewQueue()
        const control = new PreviewControlPlane(
          { resolve: async () => vitePlan },
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

        if (job.status !== "ready") {
          throw new Error(
            `expected ready, got ${job.status} (${job.errorCode ?? "no error code"}: ${job.errorMessage ?? "no message"})`,
          )
        }

        expect(job.artifact?.url).toContain(created.job.id)

        const artifactId = job.artifact?.url.match(/artifacts\/([^/]+)\//)?.[1]
        if (!artifactId) throw new Error("expected an artifact id in the URL")

        const publishedIndex = await readFile(
          path.join(storageDir, artifactId, "index.html"),
          "utf8",
        )
        expect(publishedIndex).toContain("<div id=\"root\">")
      },
      120_000,
    )
  },
)
