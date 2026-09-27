import { createHash } from "node:crypto"
import {
  lstat,
  mkdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises"
import { createServer, get as httpGet } from "node:http"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  DEFAULT_ARCHIVE_LIMITS,
  validateFetchedArchive,
} from "../core/runner/archivePolicy"
import { generatePreviewSecretValue } from "../core/backendSecrets/generatedSecretValue"
import type { RuntimeProcessHandle } from "../services/backend-runtime-worker/ports"
import { InMemoryBackendRuntimeSecretBroker } from "../services/backend-runtime-worker/secretBroker"
import { GVisorBackendRuntimeProcess } from "../services/preview-worker/gvisor/backendRuntimeProcess"
import type { GeneratedSecretFilesystem } from "../services/preview-worker/gvisor/generatedSecretFilesystem"
import { TmpfsGeneratedSecretFilesystem } from "../services/preview-worker/gvisor/generatedSecretFilesystem"
import { GeneratedSecretOrphanReaper } from "../services/preview-worker/gvisor/generatedSecretOrphanReaper"
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
  SANDBOX_NODE_BINARY,
  SANDBOX_SECRET_BOOTSTRAP,
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
import { createRealGeneratedSecretTestRoot } from "./support/realGeneratedSecretTestRoot"
import { createRealGvisorTestDirectory } from "./support/realGvisorTestRoot"
import {
  reconcileDedicatedRunscStateForCleanup,
  scanRunscStateForRawValue,
} from "./support/realRunscStateInspection"

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
  generatedSecretNames: [],
}

interface RealBackendEnvironment {
  rootDir: string
  bundlesRootDir: string
  runscRootDir: string
  /** True when `runscRootDir` is a per-test directory this environment
   * exclusively owns (see `createEnvironment`'s `dedicatedRunscRoot`
   * option), rather than the shared production-default root. Cleanup must
   * reconcile real runsc-created kernel namespace mounts under a dedicated
   * root before removing it -- the shared root is never removed at all. */
  dedicatedRunscRoot: boolean
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
        if (!clean) {
          process.stderr.write(
            `Real backend fixture cleanup is incomplete; preserving test-owned root for marker-driven reconciliation: ${root}\n`,
          )
          continue
        }
        if (environment?.dedicatedRunscRoot) {
          // A plain recursive rm can hit EBUSY on a genuine runsc-created
          // kernel namespace mount (e.g. null-netns) still living under
          // this dedicated, test-owned runsc root. Reconcile it first --
          // and never force-remove the root if that reconciliation cannot
          // prove the mount is gone.
          const reconciled = await reconcileDedicatedRunscStateForCleanup(
            environment.runscRootDir,
          ).catch((error: unknown): { ok: false; reason: string } => ({
            ok: false,
            reason: `Reconciliation threw: ${error instanceof Error ? error.message : String(error)}`,
          }))
          if (!reconciled.ok) {
            process.stderr.write(
              `Real backend fixture cleanup is incomplete; preserving test-owned root because its dedicated runsc state could not be reconciled (${reconciled.reason}): ${root}\n`,
            )
            continue
          }
        }
        await rm(root, { recursive: true, force: true })
      }
      ownedRoots.clear()
      environments.clear()
    })

    async function createEnvironment(
      prefix: string,
      options: {
        staleNetworkOwner?: boolean
        /** Dedicated per-test runsc state root instead of the shared
         * production-default `RUNSC_ROOT_DIR`. Generated-secret persistence
         * inspection reads this directory's contents directly, so it must
         * contain only state this one test created -- never production's or
         * another test's containers. */
        dedicatedRunscRoot?: boolean
        generatedSecretFilesystem?: GeneratedSecretFilesystem
      } = {},
    ): Promise<RealBackendEnvironment> {
      const rootDir = await createRealGvisorTestDirectory(prefix)
      ownedRoots.add(rootDir)
      const bundlesRootDir = path.join(rootDir, "bundles")
      const leaseDir = path.join(rootDir, "network-leases")
      const runscRootDir = options.dedicatedRunscRoot
        ? path.join(rootDir, "runsc")
        : RUNSC_ROOT_DIR
      await Promise.all([
        mkdir(bundlesRootDir, { recursive: true }),
        mkdir(leaseDir, { recursive: true }),
        ...(options.dedicatedRunscRoot
          ? [mkdir(runscRootDir, { recursive: true })]
          : []),
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
        runscRootDir,
        processRunner,
        networkProvisioner,
        diskManager,
      })
      const runtimeStarter = new GVisorBackendRuntimeProcess({
        runscRootDir,
        processRunner,
        maxRuntimeMs: 120_000,
        generatedSecretFilesystem: options.generatedSecretFilesystem,
      })

      const environment = {
        rootDir,
        bundlesRootDir,
        runscRootDir,
        dedicatedRunscRoot: options.dedicatedRunscRoot ?? false,
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

    async function createEnvironmentWithSecrets(prefix: string): Promise<
      RealBackendEnvironment & {
        secretTestRoot: string
      }
    > {
      const secretTestRoot = await createRealGeneratedSecretTestRoot()
      // No verifyMemoryBackedRoot/setOwnership/setMode overrides: this must
      // exercise the real `findmnt`-backed tmpfs check and real chown/chmod,
      // the same as production, not the portable-test fakes.
      const secretFilesystem = new TmpfsGeneratedSecretFilesystem({
        rootDir: secretTestRoot,
      })
      const environment = await createEnvironment(prefix, {
        dedicatedRunscRoot: true,
        generatedSecretFilesystem: secretFilesystem,
      })
      return { ...environment, secretTestRoot }
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

    it("injects real generated secret material through the trusted bootstrap, keeps it out of persisted OCI/argv/runsc state, forwards SIGTERM through PID 1, and cleans tmpfs after stop", async () => {
      const runtimeId = "real-backend-secret"
      const environment = await createEnvironmentWithSecrets(
        "peephole-real-backend-secret-",
      )
      const { secretTestRoot } = environment
      const workspaces: GVisorPreviewWorkspace[] = []
      const handles: RuntimeProcessHandle[] = []

      try {
        const workspace =
          await environment.sandboxProvisioner.allocate(runtimeId)
        workspaces.push(workspace)
        await writeFile(
          path.join(workspace.rootDir, "secret-check-server.js"),
          secretCheckServerScript,
        )
        const network = await workspace.ensureIngressOnlyNetworkNamespace()

        const broker = new InMemoryBackendRuntimeSecretBroker()
        broker.issue(runtimeId, ["SESSION_SECRET"])
        const material = broker.take(runtimeId)
        if (!material) {
          throw new Error("Expected freshly issued generated secret material.")
        }
        const opaqueValue = material.values.get("SESSION_SECRET")
        if (!opaqueValue) {
          throw new Error("Expected a generated SESSION_SECRET value.")
        }
        const rawValue = opaqueValue.reveal()
        if (rawValue.length === 0) {
          throw new Error("Generated SESSION_SECRET value was empty.")
        }
        const expectedSha256 = createHash("sha256")
          .update(rawValue, "utf8")
          .digest("hex")

        const handle = await environment.runtimeStarter.start(
          workspace,
          secretPlanFor("secret-check-server.js"),
          material,
        )
        handles.push(handle)
        await handle.waitUntilReady(30_000)

        // --- 5. Prove the child received the value, only as a digest. ---
        const check = await getJson(
          network.peerIp,
          fixturePlan.internalPort,
          "/secret-check",
        )
        const body = check.body as { configured?: boolean; sha256?: unknown }
        expect(check.statusCode).toBe(200)
        expect(body.configured).toBe(true)
        expect(body.sha256).toBe(expectedSha256)

        // --- 6. Inspect OCI config.json structurally. ---
        const bundleDir = workspace.bundleDir
        const serialized = await readFile(
          path.join(bundleDir, "config.json"),
          "utf8",
        )
        const config = JSON.parse(serialized) as {
          process: { env: string[]; args: string[] }
          mounts: Array<{
            destination: string
            type: string
            source: string
            options: string[]
          }>
        }
        expect(serialized.includes(rawValue)).toBe(false)
        expect(config.process.env).toEqual([
          "PORT=3000",
          "HOST=0.0.0.0",
          "NODE_ENV=production",
        ])
        expect(config.process.args).toEqual([
          SANDBOX_NODE_BINARY,
          SANDBOX_SECRET_BOOTSTRAP,
          "secret-check-server.js",
        ])
        expect(config.process.args.includes(rawValue)).toBe(false)
        const secretMounts = config.mounts.filter(
          (mount) => mount.destination === "/run/secrets",
        )
        expect(secretMounts).toEqual([
          {
            destination: "/run/secrets",
            type: "bind",
            source: path.join(secretTestRoot, runtimeId),
            options: ["bind", "ro", "nosuid", "nodev", "noexec"],
          },
        ])

        // --- 7. tmpfs material lifetime, while running. ---
        const runtimeSecretDir = path.join(secretTestRoot, runtimeId)
        const secretDirStats = await lstat(runtimeSecretDir)
        expect(secretDirStats.isDirectory()).toBe(true)
        expect(secretDirStats.mode & 0o777).toBe(0o700)
        expect(secretDirStats.uid).toBe(SANDBOX_UID)
        expect(secretDirStats.gid).toBe(SANDBOX_GID)
        const secretFileStats = await lstat(path.join(runtimeSecretDir, "env"))
        expect(secretFileStats.isFile()).toBe(true)
        expect(secretFileStats.mode & 0o777).toBe(0o600)
        expect(secretFileStats.uid).toBe(SANDBOX_UID)
        expect(secretFileStats.gid).toBe(SANDBOX_GID)

        // --- 9. runsc state raw-value non-persistence, while active. ---
        // A thrown BoundedRawValueScanError (unreadable file/directory, or a
        // bound that would be exceeded) fails this test outright rather than
        // being swallowed into a false "clean" result -- `complete` is only
        // ever `true` on a normal return, so this pair of assertions is the
        // full proof the entire dedicated runsc root was inspected. The only
        // structural exclusion this may apply is a real runsc-created
        // `null-netns` kernel namespace mount, proven against
        // `/proc/self/mountinfo` -- never inferred from its name alone (see
        // tests/support/realRunscStateInspection.ts).
        const activeScan = await scanRunscStateForRawValue(
          environment.runscRootDir,
          rawValue,
        )
        expect(activeScan.complete).toBe(true)
        expect(activeScan.found).toBe(false)

        // --- 10. Narrow egress regression check for this variant. ---
        const leases = await environment.leaseManager.listOwnedLeases()
        const lease = requireIngressLease(leases, network.peerIp)
        const defaultRoute = await runChecked(environment.processRunner, "ip", [
          "-n",
          lease.namespace,
          "route",
          "show",
          "default",
        ])
        expect(defaultRoute.stdout.trim()).toBe("")

        // --- 8. Real bootstrap PID-1 SIGTERM forwarding, via the real stop(). ---
        await handle.stop()
        await handle.stop()
        await handle.waitForExit()
        handles.splice(handles.indexOf(handle), 1)

        const sentinelRaw = await readFile(
          path.join(workspace.rootDir, "signal-forwarded.json"),
          "utf8",
        )
        const sentinel = JSON.parse(sentinelRaw) as {
          signal?: string
          received?: boolean
        }
        expect(sentinel).toEqual({ signal: "SIGTERM", received: true })
        expect(sentinelRaw.includes(rawValue)).toBe(false)

        // --- 7 (continued). tmpfs material removed after stop. ---
        await expect(lstat(runtimeSecretDir)).rejects.toThrow()

        // --- 9 (continued). runsc state raw-value non-persistence, post-stop. ---
        const postStopScan = await scanRunscStateForRawValue(
          environment.runscRootDir,
          rawValue,
        )
        expect(postStopScan.complete).toBe(true)
        expect(postStopScan.found).toBe(false)

        await workspace.destroy()
        workspaces.splice(workspaces.indexOf(workspace), 1)

        process.stdout.write(
          `[real-backend-v1-secret] ${JSON.stringify({
            secretInjected: true,
            configLeak: serialized.includes(rawValue),
            argvLeak: config.process.args.includes(rawValue),
            tmpfsCleanup: "passed",
            signalForwarding: "passed",
            runscValueLeak: activeScan.found || postStopScan.found,
            runscSkippedKernelNamespaceMounts: {
              active: activeScan.skippedKernelNamespaceMounts,
              postStop: postStopScan.skippedKernelNamespaceMounts,
            },
            egressRegression: "passed",
          })}\n`,
        )
      } finally {
        for (const handle of handles.reverse()) {
          await handle.stop().catch(() => undefined)
        }
        for (const workspace of workspaces.reverse()) {
          await workspace.destroy().catch(() => undefined)
        }
        await rm(secretTestRoot, { recursive: true, force: true })
      }
    }, 120_000)

    it("boundedly reaps only a stale test-owned generated-secret directory from the real tmpfs root", async () => {
      const secretTestRoot = await createRealGeneratedSecretTestRoot()
      try {
        const filesystem = new TmpfsGeneratedSecretFilesystem({
          rootDir: secretTestRoot,
        })
        const staleRuntimeId = "real-secret-stale-aaaa"
        const freshRuntimeId = "real-secret-fresh-bbbb"
        await filesystem.create({
          runtimeId: staleRuntimeId,
          values: new Map([["SESSION_SECRET", generatePreviewSecretValue()]]),
        })
        await filesystem.create({
          runtimeId: freshRuntimeId,
          values: new Map([["SESSION_SECRET", generatePreviewSecretValue()]]),
        })
        const staleDir = path.join(secretTestRoot, staleRuntimeId)
        const past = new Date(Date.now() - 60 * 60_000)
        await utimes(staleDir, past, past)
        // Name deliberately fails the runtime-id shape (contains "_"), so a
        // bounded reap must never touch it even though it sits directly
        // under the same root.
        const unrelatedDir = path.join(secretTestRoot, "not_a_runtime_id")
        await mkdir(unrelatedDir, { recursive: true })

        const reaper = new GeneratedSecretOrphanReaper({
          rootDir: secretTestRoot,
          filesystem,
          maxAgeMs: 30 * 60_000,
        })
        const removed = await reaper.reap()

        expect(removed).toEqual([staleRuntimeId])
        await expect(lstat(staleDir)).rejects.toThrow()
        await expect(
          lstat(path.join(secretTestRoot, freshRuntimeId)),
        ).resolves.toBeTruthy()
        await expect(lstat(unrelatedDir)).resolves.toBeTruthy()
        await expect(lstat(secretTestRoot)).resolves.toBeTruthy()

        process.stdout.write(
          `[real-backend-v1-secret-reaper] ${JSON.stringify({
            staleReaped: true,
            freshPreserved: true,
            unrelatedPreserved: true,
            rootIntact: true,
          })}\n`,
        )
      } finally {
        await rm(secretTestRoot, { recursive: true, force: true })
      }
    }, 30_000)
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

function secretPlanFor(entrypoint: string): BackendRuntimePlan {
  return {
    ...fixturePlan,
    sourceRoot: ".",
    start: { command: "node", args: [entrypoint] },
    generatedSecretNames: ["SESSION_SECRET"],
  }
}

/** CommonJS, matching minimalServerScript: this runs with sourceRoot "."
 * (no package.json), which Node treats as CommonJS by default. Exposes only
 * a non-reversible digest of the injected secret -- never the raw value --
 * and writes a fixed, non-secret sentinel when it observes SIGTERM, proving
 * the trusted bootstrap (`scripts/gvisor/secret-bootstrap.mjs`) actually
 * forwarded a real signal from real runsc's PID 1. */
const secretCheckServerScript = `
const http = require("http")
const crypto = require("crypto")
const fs = require("fs")
const port = Number(process.env.PORT)

process.on("SIGTERM", () => {
  try {
    fs.writeFileSync(
      "/workspace/signal-forwarded.json",
      JSON.stringify({ signal: "SIGTERM", received: true }),
    )
  } finally {
    process.exit(0)
  }
})

const server = http.createServer((request, response) => {
  if (request.url === "/secret-check") {
    const value = process.env.SESSION_SECRET
    response.writeHead(200, { "content-type": "application/json" })
    if (typeof value !== "string" || value.length === 0) {
      response.end(JSON.stringify({ configured: false }))
      return
    }
    const sha256 = crypto.createHash("sha256").update(value, "utf8").digest("hex")
    response.end(JSON.stringify({ configured: true, sha256 }))
    return
  }
  response.writeHead(404)
  response.end()
})
server.listen(port, "0.0.0.0")
`

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
