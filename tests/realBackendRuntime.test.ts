import { lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer, get as httpGet } from "node:http"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  DEFAULT_ARCHIVE_LIMITS,
  validateFetchedArchive,
} from "../core/runner/archivePolicy"
import type { RuntimeProcessHandle } from "../services/backend-runtime-worker/ports"
import { GVisorBackendRuntimeProcess } from "../services/preview-worker/gvisor/backendRuntimeProcess"
import { GVisorOrphanReaper } from "../services/preview-worker/gvisor/gvisorOrphanReaper"
import { GVisorSandboxProvisioner } from "../services/preview-worker/gvisor/gvisorSandboxProvisioner"
import type { GVisorPreviewWorkspace } from "../services/preview-worker/gvisor/gvisorWorkspace"
import { VethNatNetworkProvisioner } from "../services/preview-worker/gvisor/networkNamespace"
import { NetworkOrphanReaper } from "../services/preview-worker/gvisor/networkOrphanReaper"
import { NodeProcessRunner } from "../services/preview-worker/gvisor/nodeProcessRunner"
import { RunscCommandRunner } from "../services/preview-worker/gvisor/runscCommandRunner"
import { LoopbackSandboxDiskManager } from "../services/preview-worker/gvisor/sandboxDisk"
import {
  SANDBOX_GID,
  SANDBOX_UID,
} from "../services/preview-worker/gvisor/sandboxIdentity"
import {
  NetworkLeaseManager,
  type NetworkLease,
} from "../services/preview-worker/gvisor/subnetAllocator"
import { ArchiveByteStore } from "../services/preview-worker/local/archiveByteStore"
import { ExtractionState } from "../services/preview-worker/local/extractionState"
import { GitHubCommitArchiveFetcher } from "../services/preview-worker/local/githubCommitArchiveFetcher"
import { minimalNpmEnv } from "../services/preview-worker/local/npmDependencyInstaller"
import type { BackendRuntimePlan } from "../types/backendRuntime"
import { createRealGvisorTestDirectory } from "./support/realGvisorTestRoot"

const FIXTURE_COMMIT = "eae411a288b212201933cebb206126dd5bb0d93e"
const RUNSC_ROOT_DIR = "/var/run/peephole/runsc"
const baseRootfsImage =
  process.env.PEEPHOLE_GVISOR_BASE_ROOTFS ?? "/var/lib/peephole/base-rootfs"

const fixturePlan: BackendRuntimePlan = {
  contractVersion: "backend-v1",
  repository: {
    // The fetcher addresses immutable source by owner/name/SHA. The numeric
    // id is still present because it is part of the normal repository ref.
    repositoryId: 1,
    owner: "The-peephole",
    name: "peephole-fixture-fullstack",
    commitSha: FIXTURE_COMMIT,
  },
  sourceRoot: "backend",
  adapterId: "express-node-npm-v1",
  packageManager: "npm",
  install: { command: "npm", args: ["ci", "--no-audit", "--no-fund"] },
  start: { command: "node", args: ["src/server.js"] },
  internalPort: 3000,
  platformEnvironment: {
    PORT: "3000",
    HOST: "0.0.0.0",
    NODE_ENV: "production",
  },
}

interface RealBackendEnvironment {
  rootDir: string
  bundlesRootDir: string
  runscRootDir: string
  processRunner: NodeProcessRunner
  leaseManager: NetworkLeaseManager
  networkProvisioner: VethNatNetworkProvisioner
  diskManager: LoopbackSandboxDiskManager
  sandboxProvisioner: GVisorSandboxProvisioner
  runtimeStarter: GVisorBackendRuntimeProcess
}

interface ConnectionResult {
  connected: boolean
  error: string | null
}

interface NetworkProbeResult {
  routes: string
  attempts: Record<string, ConnectionResult>
}

// This is intentionally a stricter opt-in than a truthy environment value:
// a privileged host test must never run because the variable was set to an
// accidental value such as "0" or "false".
describe.skipIf(process.env.PEEPHOLE_REAL_GVISOR_TESTS !== "1")(
  "real backend-v1 runtime (Linux + runsc required)",
  () => {
    const ownedRoots = new Set<string>()
    const environments = new Map<string, RealBackendEnvironment>()

    afterEach(async () => {
      for (const root of ownedRoots) {
        const environment = environments.get(root)
        const clean = environment
          ? await environmentIsClean(environment).catch(() => false)
          : true
        if (clean) {
          await rm(root, { recursive: true, force: true })
        } else {
          process.stderr.write(
            `Real backend fixture cleanup is incomplete; preserving test-owned root for marker-driven reconciliation: ${root}\n`,
          )
        }
      }
      ownedRoots.clear()
      environments.clear()
    })

    async function createEnvironment(
      prefix: string,
      options: { staleNetworkOwner?: boolean } = {},
    ): Promise<RealBackendEnvironment> {
      const rootDir = await createRealGvisorTestDirectory(prefix)
      ownedRoots.add(rootDir)
      const bundlesRootDir = path.join(rootDir, "bundles")
      const leaseDir = path.join(rootDir, "network-leases")
      await Promise.all([
        mkdir(bundlesRootDir, { recursive: true }),
        mkdir(leaseDir, { recursive: true }),
      ])

      const processRunner = new NodeProcessRunner()
      const leaseManager = new NetworkLeaseManager({
        leaseDir,
        ...(options.staleNetworkOwner
          ? { processState: () => "MISSING" as const }
          : {}),
      })
      const networkProvisioner = new VethNatNetworkProvisioner({
        processRunner,
        leaseManager,
      })
      const diskManager = new LoopbackSandboxDiskManager({
        bundlesRootDir,
        processRunner,
      })
      const sandboxProvisioner = new GVisorSandboxProvisioner({
        baseRootfsImage,
        runscRootDir: RUNSC_ROOT_DIR,
        processRunner,
        networkProvisioner,
        diskManager,
      })
      const runtimeStarter = new GVisorBackendRuntimeProcess({
        runscRootDir: RUNSC_ROOT_DIR,
        processRunner,
        maxRuntimeMs: 120_000,
      })

      const environment = {
        rootDir,
        bundlesRootDir,
        runscRootDir: RUNSC_ROOT_DIR,
        processRunner,
        leaseManager,
        networkProvisioner,
        diskManager,
        sandboxProvisioner,
        runtimeStarter,
      }
      environments.set(rootDir, environment)
      return environment
    }

    it("runs the pinned Express fixture with host ingress, denied egress, and complete idempotent cleanup", async () => {
      const environment = await createEnvironment(
        "peephole-real-backend-runtime-",
      )
      const workspaces: GVisorPreviewWorkspace[] = []
      const handles: RuntimeProcessHandle[] = []
      let controlPlaneServer: ReturnType<typeof createServer> | undefined

      try {
        const workspace = await environment.sandboxProvisioner.allocate(
          "real-backend-fixture",
        )
        workspaces.push(workspace)
        const primaryBundleDir = workspace.bundleDir
        const primaryWorkspaceRoot = workspace.rootDir

        const byteStore = new ArchiveByteStore()
        const archive = await new GitHubCommitArchiveFetcher(byteStore).fetch(
          fixturePlan.repository,
        )
        validateFetchedArchive(archive, DEFAULT_ARCHIVE_LIMITS)
        const extraction = new ExtractionState()
        await extraction.ensureExtracted(workspace, FIXTURE_COMMIT, byteStore)
        for (const relative of [
          ".",
          "backend",
          "backend/package.json",
          "backend/src",
          "backend/src/server.js",
        ]) {
          const candidate =
            relative === "."
              ? workspace.rootDir
              : path.join(workspace.rootDir, relative)
          const stats = await lstat(candidate)
          expect(stats.uid, `${relative} uid`).toBe(SANDBOX_UID)
          expect(stats.gid, `${relative} gid`).toBe(SANDBOX_GID)
          expect(
            stats.mode & 0o022,
            `${relative} writable by group/other`,
          ).toBe(0)
          if (stats.isDirectory()) {
            expect(
              stats.mode & 0o700,
              `${relative} owner directory access`,
            ).toBe(0o700)
          }
        }
        expect(
          (
            await lstat(
              path.join(workspace.rootDir, "backend", "package-lock.json"),
            )
          ).isFile(),
        ).toBe(true)
        expect(
          (
            await lstat(
              path.join(workspace.rootDir, "backend", "src", "server.js"),
            )
          ).isFile(),
        ).toBe(true)

        const installRunner = new RunscCommandRunner({
          network: "sandbox",
          runscRootDir: environment.runscRootDir,
          processRunner: environment.processRunner,
        })
        await installRunner.run(
          workspace,
          fixturePlan.install.command,
          [...fixturePlan.install.args],
          {
            workingDirectory: fixturePlan.sourceRoot,
            timeoutMs: 90_000,
            env: minimalNpmEnv(),
          },
        )

        const primaryNetwork =
          await workspace.ensureIngressOnlyNetworkNamespace()
        const primaryHandle = await environment.runtimeStarter.start(
          workspace,
          fixturePlan,
        )
        handles.push(primaryHandle)
        await primaryHandle.waitUntilReady(30_000)

        const health = await getJson(
          primaryNetwork.peerIp,
          fixturePlan.internalPort,
          "/health",
        )
        expect(health).toEqual({
          statusCode: 200,
          body: {
            status: "ok",
            service: "peephole-fixture-backend",
          },
        })
        const hello = await getJson(
          primaryNetwork.peerIp,
          fixturePlan.internalPort,
          "/api/hello",
        )
        expect(hello).toEqual({
          statusCode: 200,
          body: { message: "Hello from Peephole backend" },
        })

        const leases = await environment.leaseManager.listOwnedLeases()
        const primaryLease = requireIngressLease(leases, primaryNetwork.peerIp)
        const before = await inspectNetworkResources(
          environment.processRunner,
          primaryLease,
        )
        expect(before).toEqual({
          namespace: true,
          hostVeth: true,
          ipv4: true,
          nat: false,
          ipv6: true,
        })
        const defaultRoute = await runChecked(environment.processRunner, "ip", [
          "-n",
          primaryLease.namespace,
          "route",
          "show",
          "default",
        ])
        expect(defaultRoute.stdout.trim()).toBe("")

        const isolatedWorkspace = await environment.sandboxProvisioner.allocate(
          "real-backend-isolated-peer",
        )
        workspaces.push(isolatedWorkspace)
        const isolatedBundleDir = isolatedWorkspace.bundleDir
        await writeFile(
          path.join(isolatedWorkspace.rootDir, "server.js"),
          minimalServerScript,
        )
        const isolatedNetwork =
          await isolatedWorkspace.ensureIngressOnlyNetworkNamespace()
        const isolatedHandle = await environment.runtimeStarter.start(
          isolatedWorkspace,
          planFor(".", "server.js"),
        )
        handles.push(isolatedHandle)
        await isolatedHandle.waitUntilReady(30_000)

        controlPlaneServer = createServer((_request, response) => {
          response.end("trusted-host-control-plane")
        })
        await listen(controlPlaneServer, primaryLease.hostIp)
        const address = controlPlaneServer.address()
        if (!address || typeof address === "string") {
          throw new Error("Host control-plane probe did not bind a TCP port.")
        }

        const probeTargets = {
          publicInternet: { host: "1.1.1.1", port: 80 },
          metadata: { host: "169.254.169.254", port: 80 },
          privateRfc1918: { host: "10.0.0.1", port: 80 },
          linkLocal: { host: "169.254.1.1", port: 80 },
          hostControlPlane: {
            host: primaryLease.hostIp,
            port: address.port,
          },
          otherJob: {
            host: isolatedNetwork.peerIp,
            port: fixturePlan.internalPort,
          },
        }
        await writeFile(
          path.join(workspace.rootDir, "backend", "network-probe.js"),
          networkProbeScript(probeTargets),
        )
        const probeHandle = await environment.runtimeStarter.start(
          workspace,
          planFor("backend", "network-probe.js"),
        )
        handles.push(probeHandle)
        expect(await probeHandle.waitForExit()).toEqual({ exitCode: 0 })
        const probe = JSON.parse(
          await readFile(
            path.join(workspace.rootDir, "network-probe.json"),
            "utf8",
          ),
        ) as NetworkProbeResult

        expect(probe.routes).not.toMatch(/^\S+\s+00000000\s+/mu)
        expect(Object.keys(probe.attempts).sort()).toEqual(
          Object.keys(probeTargets).sort(),
        )
        for (const result of Object.values(probe.attempts)) {
          expect(result.connected).toBe(false)
          expect(result.error).toBeTruthy()
        }

        await close(controlPlaneServer)
        controlPlaneServer = undefined

        await primaryHandle.stop()
        await primaryHandle.stop()
        await primaryHandle.waitForExit()
        handles.splice(handles.indexOf(primaryHandle), 1)
        await isolatedHandle.stop()
        await isolatedHandle.stop()
        await isolatedHandle.waitForExit()
        handles.splice(handles.indexOf(isolatedHandle), 1)
        handles.splice(handles.indexOf(probeHandle), 1)

        await workspace.destroy()
        workspaces.splice(workspaces.indexOf(workspace), 1)
        await isolatedWorkspace.destroy()
        workspaces.splice(workspaces.indexOf(isolatedWorkspace), 1)

        await expect(stat(primaryBundleDir)).rejects.toThrow()
        await expect(stat(primaryWorkspaceRoot)).rejects.toThrow()
        await expect(stat(isolatedBundleDir)).rejects.toThrow()
        expect(await environment.diskManager.listOwnedAllocations()).toEqual([])
        expect(await environment.leaseManager.listOwnedLeases()).toEqual([])
        expect(
          await inspectNetworkResources(
            environment.processRunner,
            primaryLease,
          ),
        ).toEqual({
          namespace: false,
          hostVeth: false,
          ipv4: false,
          nat: false,
          ipv6: false,
        })
        expect(await listOwnedTestContainers(environment)).toEqual([])

        process.stdout.write(
          `[real-backend-v1] ${JSON.stringify({ fixtureCommit: FIXTURE_COMMIT, readiness: "ready", health: health.body, hello: hello.body, outbound: probe.attempts, noDefaultRoute: true, noRuntimeNat: true, repeatedStop: "passed", runscCleanup: "passed", networkCleanup: "passed", diskCleanup: "passed" })}\n`,
        )
      } finally {
        if (controlPlaneServer) await close(controlPlaneServer)
        for (const handle of handles.reverse()) {
          await handle.stop().catch(() => undefined)
        }
        for (const workspace of workspaces.reverse()) {
          await workspace.destroy().catch(() => undefined)
        }
      }
    }, 180_000)

    it("reaps an abandoned live backend container, network, and disk after worker-style ownership loss", async () => {
      const environment = await createEnvironment(
        "peephole-real-backend-orphan-",
        { staleNetworkOwner: true },
      )
      const workspace = await environment.sandboxProvisioner.allocate(
        "real-backend-orphan",
      )
      await writeFile(
        path.join(workspace.rootDir, "server.js"),
        minimalServerScript,
      )
      const network = await workspace.ensureIngressOnlyNetworkNamespace()
      const handle = await environment.runtimeStarter.start(
        workspace,
        planFor(".", "server.js"),
      )
      await handle.waitUntilReady(30_000)

      const [containerId] = workspace.listContainers()
      if (!containerId) throw new Error("Expected a live backend container.")
      const [allocation] = await environment.diskManager.listOwnedAllocations()
      if (!allocation) throw new Error("Expected an owned disk allocation.")
      const lease = requireIngressLease(
        await environment.leaseManager.listOwnedLeases(),
        network.peerIp,
      )
      expect(
        (
          await listRunscContainers(
            environment.processRunner,
            environment.runscRootDir,
          )
        ).some((container) => container.id === containerId),
      ).toBe(true)
      expect(
        await inspectNetworkResources(environment.processRunner, lease),
      ).toEqual({
        namespace: true,
        hostVeth: true,
        ipv4: true,
        nat: false,
        ipv6: true,
      })

      const diskReaper = new GVisorOrphanReaper({
        runscRootDir: environment.runscRootDir,
        diskManager: environment.diskManager,
        processRunner: environment.processRunner,
      })
      const networkReaper = new NetworkOrphanReaper({
        leaseManager: environment.leaseManager,
        processRunner: environment.processRunner,
      })
      expect(await diskReaper.reapAll()).toEqual([
        path.basename(allocation.bundleDir),
      ])
      await networkReaper.reapAll()

      expect(
        (
          await listRunscContainers(
            environment.processRunner,
            environment.runscRootDir,
          )
        ).some((container) => container.id === containerId),
      ).toBe(false)
      await expect(stat(allocation.bundleDir)).rejects.toThrow()
      await expect(stat(allocation.mountpoint)).rejects.toThrow()
      await expect(stat(allocation.imagePath)).rejects.toThrow()
      expect(await environment.diskManager.listOwnedAllocations()).toEqual([])
      expect(await environment.leaseManager.listOwnedLeases()).toEqual([])
      expect(
        await inspectNetworkResources(environment.processRunner, lease),
      ).toEqual({
        namespace: false,
        hostVeth: false,
        ipv4: false,
        nat: false,
        ipv6: false,
      })

      // Startup reconciliation is itself safe to repeat after the first pass.
      expect(await diskReaper.reapAll()).toEqual([])
      await networkReaper.reapAll()

      process.stdout.write(
        `[real-backend-v1-orphan] ${JSON.stringify({ containerId, runscCleanup: "passed", networkCleanup: "passed", diskCleanup: "passed", repeatedReconciliation: "passed" })}\n`,
      )
      // Deliberately do not call handle.stop() or workspace.destroy(): the
      // fresh reapers above are the only owners that performed cleanup.
      void handle
    }, 90_000)
  },
)

function planFor(sourceRoot: string, entrypoint: string): BackendRuntimePlan {
  return {
    ...fixturePlan,
    sourceRoot,
    start: { command: "node", args: [entrypoint] },
  }
}

const minimalServerScript = `
const http = require("http")
const port = Number(process.env.PORT)
http.createServer((_request, response) => response.end("ok")).listen(port, "0.0.0.0")
`

function networkProbeScript(
  targets: Record<string, { host: string; port: number }>,
): string {
  return `
import fs from "node:fs"
import net from "node:net"

const targets = ${JSON.stringify(targets)}
const connect = ({ host, port }) => new Promise((resolve) => {
  const socket = net.createConnection({ host, port })
  const finish = (connected, error) => {
    socket.removeAllListeners()
    socket.destroy()
    resolve({ connected, error })
  }
  socket.setTimeout(1500, () => finish(false, "timeout"))
  socket.once("connect", () => finish(true, null))
  socket.once("error", (error) => finish(false, error.code || error.message))
})

const attempts = {}
for (const [name, target] of Object.entries(targets)) {
  attempts[name] = await connect(target)
}
fs.writeFileSync(
  "/workspace/network-probe.json",
  JSON.stringify({ routes: fs.readFileSync("/proc/net/route", "utf8"), attempts }),
)
`
}

function requireIngressLease(
  leases: readonly NetworkLease[],
  peerIp: string,
): NetworkLease {
  const lease = leases.find(
    (candidate) =>
      candidate.policy === "ingress-only" && candidate.peerIp === peerIp,
  )
  if (!lease) throw new Error(`Expected ingress-only lease for ${peerIp}.`)
  return lease
}

async function getJson(
  host: string,
  port: number,
  requestPath: string,
): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpGet(
      { host, port, path: requestPath, timeout: 5_000 },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.once("error", reject)
        response.once("end", () => {
          try {
            resolve({
              statusCode: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            })
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    request.once("timeout", () => request.destroy(new Error("HTTP timeout")))
    request.once("error", reject)
  })
}

function listen(
  server: ReturnType<typeof createServer>,
  host: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, host, () => {
      server.off("error", reject)
      resolve()
    })
  })
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function runChecked(
  runner: NodeProcessRunner,
  command: string,
  args: string[],
) {
  const result = await runner.run(command, args, { timeoutMs: 10_000 })
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(
      `${command} failed (exit ${String(result.exitCode)}, timedOut=${String(result.timedOut)}): ${result.stderr || result.stdout}`,
    )
  }
  return result
}

async function listRunscContainers(
  runner: NodeProcessRunner,
  runscRootDir: string,
): Promise<Array<{ id: string; bundle: string }>> {
  const result = await runChecked(runner, "runsc", [
    "--root",
    runscRootDir,
    "list",
    "--format",
    "json",
  ])
  const parsed = JSON.parse(result.stdout) as unknown
  if (parsed === null) return []
  if (!Array.isArray(parsed)) {
    throw new Error("runsc list did not return an array.")
  }
  return parsed.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as { id?: unknown }).id !== "string" ||
      typeof (entry as { bundle?: unknown }).bundle !== "string"
    ) {
      throw new Error("runsc list returned an invalid container record.")
    }
    return entry as { id: string; bundle: string }
  })
}

async function inspectNetworkResources(
  runner: NodeProcessRunner,
  lease: NetworkLease,
) {
  const [namespaces, links, ipv4, nat, ipv6] = await Promise.all([
    runChecked(runner, "ip", ["netns", "list"]),
    runChecked(runner, "ip", ["-o", "link", "show"]),
    runChecked(runner, "iptables", ["-w", "5", "-S"]),
    runChecked(runner, "iptables", ["-w", "5", "-t", "nat", "-S"]),
    runChecked(runner, "ip6tables", ["-w", "5", "-S"]),
  ])
  return {
    namespace: namespaces.stdout.includes(lease.namespace),
    hostVeth: links.stdout.includes(lease.hostVeth),
    ipv4:
      ipv4.stdout.includes(lease.egressChain) &&
      ipv4.stdout.includes(lease.inputChain) &&
      ipv4.stdout.includes(lease.returnChain),
    nat: nat.stdout.includes(lease.iptablesComment),
    ipv6: ipv6.stdout.includes(lease.hostVeth),
  }
}

async function environmentIsClean(
  environment: RealBackendEnvironment,
): Promise<boolean> {
  const [allocations, leases, containers] = await Promise.all([
    environment.diskManager.listOwnedAllocations(),
    environment.leaseManager.listOwnedLeases(),
    listOwnedTestContainers(environment),
  ])
  return (
    allocations.length === 0 && leases.length === 0 && containers.length === 0
  )
}

async function listOwnedTestContainers(
  environment: RealBackendEnvironment,
): Promise<Array<{ id: string; bundle: string }>> {
  const containers = await listRunscContainers(
    environment.processRunner,
    environment.runscRootDir,
  )
  const root = path.resolve(environment.bundlesRootDir)
  return containers.filter((container) => {
    const relative = path.relative(root, path.resolve(container.bundle))
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    )
  })
}
