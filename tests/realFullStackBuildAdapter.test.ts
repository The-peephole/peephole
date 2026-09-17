import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { GitHubClient } from "../core/github/client"
import { PreviewControlPlane } from "../services/preview-api/controlPlane"
import { GitHubPreviewPlanResolver } from "../services/preview-api/githubPlanResolver"
import {
  FixedWindowPreviewQuota,
  HmacPreviewArtifactSigner,
  InMemoryPreviewArtifactCache,
  InMemoryPreviewJobStore,
  InMemoryPreviewQueue,
} from "../services/preview-api/inMemoryAdapters"
import { composeLocalDevWorker } from "../services/preview-worker/local/composeLocalDevWorker"

const repository = {
  repositoryId: 1_371_618_449,
  owner: "The-peephole",
  name: "peephole-fixture-fullstack",
  commitSha: "eae411a288b212201933cebb206126dd5bb0d93e",
}

describe.skipIf(!process.env.PEEPHOLE_REAL_NETWORK_TESTS)(
  "real full-stack fixture frontend-only target (network, unsandboxed development proof)",
  () => {
    let storageDir: string

    beforeAll(async () => {
      storageDir = await mkdtemp(
        path.join(os.tmpdir(), "peephole-fullstack-frontend-"),
      )
    })

    afterAll(async () => {
      await rm(storageDir, { recursive: true, force: true })
    })

    it("reauthorizes frontend, builds frontend/dist, and publishes no backend source", async () => {
      const github = new GitHubClient()
      const resolver = new GitHubPreviewPlanResolver(github)
      const plan = await resolver.resolve(repository, "static-v2", {
        sourceRoot: "frontend",
      })
      expect(plan).toMatchObject({
        contractVersion: "static-v2",
        sourceRoot: "frontend",
        packageManager: "npm",
        installCommand: "npm ci",
        buildCommand: "npm run build",
        outputDirectory: "dist",
      })

      const queue = new InMemoryPreviewQueue()
      const control = new PreviewControlPlane(
        resolver,
        new InMemoryPreviewJobStore(),
        queue,
        new InMemoryPreviewArtifactCache(),
        new HmacPreviewArtifactSigner(
          "peephole.run",
          "test-signing-secret-with-at-least-32-bytes",
        ),
        new FixedWindowPreviewQuota(),
        { runnerVersion: "runner-v2" },
      )
      const created = await control.create(
        {
          repository,
          contractVersion: "static-v2",
          target: { sourceRoot: "frontend" },
        },
        "request-frontend-0001",
        { subject: "user-1", ip: "203.0.113.10" },
      )
      const queued = queue.dequeue()
      if (!queued) throw new Error("expected a queued frontend job")

      await composeLocalDevWorker(control, {
        artifactStorageDir: storageDir,
      }).run(queued)

      const job = await control.get(created.job.id, {
        subject: "user-1",
        ip: "203.0.113.10",
      })
      expect(job.status).toBe("ready")
      const artifactId = job.artifact?.url.match(/artifacts\/([^/]+)\//)?.[1]
      if (!artifactId) throw new Error("expected an artifact id")
      const index = await readFile(
        path.join(storageDir, artifactId, "index.html"),
        "utf8",
      )
      expect(index).toContain('<div id="root">')
      await expect(
        readFile(path.join(storageDir, artifactId, "backend", "package.json")),
      ).rejects.toThrow()
    }, 180_000)
  },
)
