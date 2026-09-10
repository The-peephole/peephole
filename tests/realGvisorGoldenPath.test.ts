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
import { GVisorSandboxProvisioner } from "../services/preview-worker/gvisor/gvisorSandboxProvisioner"
import { RunscCommandRunner } from "../services/preview-worker/gvisor/runscCommandRunner"
import { LocalArtifactPublisher } from "../services/preview-worker/local/localArtifactPublisher"
import { LocalOutputLocationRegistry } from "../services/preview-worker/local/localOutputLocationRegistry"
import { LocalOutputResolver } from "../services/preview-worker/local/localOutputResolver"
import { NpmBuildExecutor } from "../services/preview-worker/local/npmBuildExecutor"
import { NpmDependencyInstaller } from "../services/preview-worker/local/npmDependencyInstaller"
import { PreviewJobWorker } from "../services/preview-worker/worker"
import type { BuildPlan, PreviewRequester } from "../types/preview"

// Same trusted, pinned, first-party fixture as
// tests/realViteReactGoldenPath.test.ts (see that file for why it's safe
// to run npm lifecycle scripts against it unsandboxed there). Here it runs
// *sandboxed*: real gVisor isolation, real non-root execution, and real
// network egress through VethNatNetworkProvisioner for install --
// end-to-end proof that the production isolation path actually produces a
// working preview, not just that its individual pieces work in isolation
// (see tests/realGvisorSandbox.test.ts for those).
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

const baseRootfsImage =
  process.env.PEEPHOLE_GVISOR_BASE_ROOTFS ?? "/var/lib/peephole/base-rootfs"

// Requires a real Linux host with runsc/ip/iptables on PATH and root (or
// equivalent) privilege, plus a prepared base rootfs image (see
// scripts/gvisor/build-base-rootfs.sh) -- opt-in, separate from
// PEEPHOLE_REAL_NETWORK_TESTS, since it needs a real Linux kernel, not
// just network access.
describe.skipIf(!process.env.PEEPHOLE_REAL_GVISOR_TESTS)(
  "real gVisor golden path (network, sandboxed, end to end)",
  () => {
    let storageDir: string
    let bundlesRootDir: string

    beforeAll(async () => {
      storageDir = await mkdtemp(
        path.join(os.tmpdir(), "peephole-gvisor-artifact-"),
      )
      bundlesRootDir = await mkdtemp(
        path.join(os.tmpdir(), "peephole-gvisor-bundles-"),
      )
    })

    afterAll(async () => {
      await rm(storageDir, { recursive: true, force: true })
      await rm(bundlesRootDir, { recursive: true, force: true })
    })

    it("runs npm ci, esbuild/Vite native execution, cross-container build, and publication with a read-only rootfs", async () => {
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
      // Install needs the npm registry (and esbuild's postinstall fetch of
      // its platform binary); the build itself (vite build) does not.
      const installRunner = new RunscCommandRunner({ network: "sandbox" })
      const buildRunner = new RunscCommandRunner({ network: "none" })

      const worker = new PreviewJobWorker(
        control,
        new GitHubCommitArchiveFetcher(byteStore),
        new GVisorSandboxProvisioner({ baseRootfsImage, bundlesRootDir }),
        new NpmDependencyInstaller(byteStore, extraction, installRunner),
        new NpmBuildExecutor(buildRunner),
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
      expect(publishedIndex).toContain('<div id="root">')
    }, 120_000)
  },
)
