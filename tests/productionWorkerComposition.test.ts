import { createServer, type Server } from "node:http"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as tar from "tar"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { PreviewControlPlane } from "../services/preview-api/controlPlane"
import {
  FixedWindowPreviewQuota,
  HmacPreviewArtifactSigner,
  InMemoryPreviewArtifactCache,
  InMemoryPreviewJobStore,
  InMemoryPreviewQueue,
} from "../services/preview-api/inMemoryAdapters"
import { composeProductionWorker } from "../services/preview-worker/gvisor/composeProductionWorker"
import { SubnetAllocator } from "../services/preview-worker/gvisor/subnetAllocator"
import { VethNatNetworkProvisioner } from "../services/preview-worker/gvisor/networkNamespace"
import type {
  ProcessRunner,
  ProcessRunResult,
} from "../services/preview-worker/gvisor/processRunner"
import type { BuildPlan, PreviewRequester } from "../types/preview"
import { FakeSandboxDiskManager } from "./fakeSandboxDiskManager"

/**
 * Proves services/production/server.ts's wiring choice -- composing
 * GVisorSandboxProvisioner/RunscCommandRunner (via composeProductionWorker),
 * never composeLocalDevWorker's unsandboxed dev adapters -- by actually
 * running a full fetch -> extract -> install -> build -> publish job
 * through it. A fake ProcessRunner stands in for `runsc`/`ip`/`iptables` (so
 * this runs anywhere, no root or real gVisor needed -- that real-host proof
 * is tests/realGvisorSandbox.test.ts and tests/realGvisorGoldenPath.test.ts)
 * while every *other* collaborator -- real archive extraction, real OCI
 * config generation, real on-disk rootfs copy -- runs for real.
 */

class RecordingProcessRunner implements ProcessRunner {
  readonly calls: Array<{ command: string; args: string[] }> = []

  async run(command: string, args: string[]): Promise<ProcessRunResult> {
    this.calls.push({ command, args })
    return {
      exitCode: 0,
      timedOut: false,
      // "route list default" parsing (VethNatNetworkProvisioner's
      // defaultUplinkInterface()) needs a real-looking "dev <iface>" token
      // regardless of which command this actually was.
      stdout: "default via 10.0.0.1 dev eth0",
      stderr: "",
    }
  }
}

const repository = {
  repositoryId: 1,
  owner: "peephole-test",
  name: "fixture-repo",
  commitSha: "a".repeat(40),
}

const plan: BuildPlan = {
  contractVersion: "static-v1",
  repository,
  sourceRoot: ".",
  packageManager: "npm",
  installCommand: "npm ci",
  buildCommand: "npm run build",
  outputDirectory: "dist",
}

const requester: PreviewRequester = { subject: "user-1", ip: "203.0.113.10" }

describe("composeProductionWorker", () => {
  let baseRootfsImage: string
  let bundlesRootDir: string
  let storageDir: string
  let leaseDir: string
  let codeloadServer: Server
  let codeloadBaseUrl: string

  beforeEach(async () => {
    baseRootfsImage = await mkdtemp(
      path.join(os.tmpdir(), "peephole-prod-rootfs-"),
    )
    bundlesRootDir = await mkdtemp(
      path.join(os.tmpdir(), "peephole-prod-bundles-"),
    )
    storageDir = await mkdtemp(
      path.join(os.tmpdir(), "peephole-prod-artifacts-"),
    )
    leaseDir = await mkdtemp(path.join(os.tmpdir(), "peephole-prod-leases-"))

    const tarball = await buildFixtureTarball()
    codeloadServer = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/gzip" })
      response.end(tarball)
    })
    await new Promise<void>((resolve) =>
      codeloadServer.listen(0, "127.0.0.1", resolve),
    )
    const address = codeloadServer.address()
    if (!address || typeof address === "string") {
      throw new Error("codeload fixture server did not bind a port")
    }
    codeloadBaseUrl = `http://127.0.0.1:${String(address.port)}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => codeloadServer.close(() => resolve()))
    await rm(baseRootfsImage, { recursive: true, force: true })
    await rm(bundlesRootDir, { recursive: true, force: true })
    await rm(storageDir, { recursive: true, force: true })
    await rm(leaseDir, { recursive: true, force: true })
  })

  it("runs a full job through the real gVisor adapters end to end (fake runsc)", async () => {
    const queue = new InMemoryPreviewQueue()
    const control = new PreviewControlPlane(
      { resolve: async () => plan },
      new InMemoryPreviewJobStore(),
      queue,
      new InMemoryPreviewArtifactCache(),
      new HmacPreviewArtifactSigner(
        "peephole.run",
        "test-signing-secret-with-at-least-32-bytes",
      ),
      new FixedWindowPreviewQuota(),
      { runnerVersion: "production-test" },
    )

    const created = await control.create(
      { repository, contractVersion: "static-v1" },
      "request-0000000001",
      requester,
    )

    const processRunner = new RecordingProcessRunner()
    const networkProvisioner = new VethNatNetworkProvisioner({
      processRunner,
      subnetAllocator: new SubnetAllocator({
        leaseDir,
        bootId: async () => "test-boot",
        processStartTime: async () => "test-start",
        syncDirectory: async () => undefined,
      }),
    })

    const worker = composeProductionWorker(control, {
      baseRootfsImage,
      bundlesRootDir,
      artifactStorageDir: storageDir,
      processRunner,
      networkProvisioner,
      codeloadBaseUrl,
      resolveDnsConfig: () => ({
        source: "/etc/resolv.conf",
        nameservers: ["172.31.0.2"],
      }),
      diskManager: new FakeSandboxDiskManager(bundlesRootDir),
    })

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

    const runCalls = processRunner.calls.filter((call) =>
      call.args.includes("run"),
    )
    expect(runCalls).toHaveLength(2)
    expect(runCalls[0]?.args).toContain("--network=sandbox") // npm ci
    expect(runCalls[1]?.args).toContain("--network=none") // npm run build
  })
})

async function buildFixtureTarball(): Promise<Buffer> {
  const sourceDir = await mkdtemp(
    path.join(os.tmpdir(), "peephole-prod-fixture-src-"),
  )

  try {
    const repoDir = path.join(sourceDir, "fixture-repo")
    await mkdir(path.join(repoDir, "dist"), { recursive: true })
    await writeFile(
      path.join(repoDir, "package.json"),
      JSON.stringify({ name: "fixture-repo", version: "0.0.0" }),
    )
    await writeFile(path.join(repoDir, "package-lock.json"), "{}")
    await writeFile(
      path.join(repoDir, "dist", "index.html"),
      "<!doctype html><title>fixture</title>",
    )

    const tarballPath = path.join(sourceDir, "fixture.tar.gz")
    await tar.create({ gzip: true, cwd: sourceDir, file: tarballPath }, [
      "fixture-repo",
    ])

    return await readFile(tarballPath)
  } finally {
    await rm(sourceDir, { recursive: true, force: true })
  }
}
