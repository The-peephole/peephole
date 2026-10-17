import { randomUUID } from "node:crypto"
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  utimes,
  writeFile,
} from "node:fs/promises"
import { get as httpGet } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { beforeAll, describe, expect, it } from "vitest"

import { buildTemporaryDatabaseUrl } from "../core/backendDatabase/databaseUrl"
import {
  deriveTemporaryDatabaseObjectName,
  mintTemporaryDatabaseResourceId,
} from "../core/backendDatabase/resourceIdentity"
import { generatePreviewSecretValue } from "../core/backendSecrets/generatedSecretValue"
import type { RuntimeProcessHandle } from "../services/backend-runtime-worker/ports"
import { InMemoryBackendRuntimeSecretBroker } from "../services/backend-runtime-worker/secretBroker"
import {
  ensureDatabaseCredentialCapability,
  ensureGeneratedSecretInjectionCapability,
  ensureUserEnvironmentCapability,
} from "../services/production/preflight"
import {
  BackendRuntimeExitedBeforeReadyError,
  GVisorBackendRuntimeProcess,
} from "../services/preview-worker/gvisor/backendRuntimeProcess"
import { TmpfsDatabaseCredentialFilesystem } from "../services/preview-worker/gvisor/databaseCredentialFilesystem"
import { TmpfsGeneratedSecretFilesystem } from "../services/preview-worker/gvisor/generatedSecretFilesystem"
import { GVisorOrphanReaper } from "../services/preview-worker/gvisor/gvisorOrphanReaper"
import { GVisorSandboxProvisioner } from "../services/preview-worker/gvisor/gvisorSandboxProvisioner"
import type { GVisorPreviewWorkspace } from "../services/preview-worker/gvisor/gvisorWorkspace"
import { VethNatNetworkProvisioner } from "../services/preview-worker/gvisor/networkNamespace"
import { NetworkOrphanReaper } from "../services/preview-worker/gvisor/networkOrphanReaper"
import { NodeProcessRunner } from "../services/preview-worker/gvisor/nodeProcessRunner"
import { LoopbackSandboxDiskManager } from "../services/preview-worker/gvisor/sandboxDisk"
import {
  SANDBOX_GID,
  SANDBOX_NODE_BINARY,
  SANDBOX_SECRET_BOOTSTRAP,
  SANDBOX_UID,
  SANDBOX_USER_ENVIRONMENT_BOOTSTRAP_FLAG,
} from "../services/preview-worker/gvisor/sandboxIdentity"
import { NetworkLeaseManager } from "../services/preview-worker/gvisor/subnetAllocator"
import {
  TmpfsUserEnvironmentFilesystem,
  USER_ENVIRONMENT_FILE_NAME,
  type UserEnvironmentFilesystem,
} from "../services/preview-worker/gvisor/userEnvironmentFilesystem"
import { UserEnvironmentOrphanReaper } from "../services/preview-worker/gvisor/userEnvironmentOrphanReaper"
import { InMemoryUserEnvironmentBroker } from "../services/user-environment/userEnvironmentBroker"
import type { BackendRuntimePlan } from "../types/backendRuntime"
import type {
  UserEnvironmentEntry,
  UserEnvironmentMaterial,
} from "../types/userEnvironment"
import {
  M12HarnessPreflightError,
  combineScanStatuses,
  createOwnedRunSet,
  destroyWorkspaces,
  findProductionHostMarkers,
  deriveM12ComponentPaths,
  formatM12PreflightSummary,
  inspectM12TestRootfs,
  m12RealSuiteEnabled,
  protectedResourceRoots,
  readM12HarnessConfig,
  removeOwnedRunDirectory,
  runWithOwnedCleanup,
  scanFileForRawValueStatus,
  scanForRawValueStatus,
  sha256,
  stopRuntimeHandles,
  type M12ComponentPaths,
  type M12HarnessConfig,
  type M12RunDirectories,
  type ScanStatus,
  withSetupRollback,
} from "./support/m12RealGvisorHarness"
import {
  reconcileDedicatedRunscStateForCleanup,
  scanRunscStateForRawValue,
} from "./support/realRunscStateInspection"
import { PendingSignalProcessRunner } from "./support/pendingSignalProcessRunner"
import { M12_JOURNAL_SENTINELS } from "./support/isolatedJournalVerification"
import { safeRealTest } from "./support/safeRealTest"

/**
 * M12 real Linux/gVisor verification. Skipped unless BOTH
 * PEEPHOLE_REAL_GVISOR_TESTS=1 and PEEPHOLE_M12_REAL_GVISOR_TESTS=1, and then
 * refuses to run unless every PEEPHOLE_M12_TEST_* root is explicit, canonical,
 * and disjoint from production (tests/support/m12RealGvisorHarness.ts).
 * Operator procedure: docs/M12_REAL_GVISOR_VERIFICATION.md.
 *
 * The synthetic value below is not a credential. The fixture reports only
 * its SHA-256 digest; no assertion message, log line, or evidence record
 * contains a raw value.
 */
const [SYNTHETIC_VALUE, SECOND_SYNTHETIC_VALUE] = M12_JOURNAL_SENTINELS
const ENTRYPOINT = "m12-digest-server.cjs"
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
)
const FIXTURE_PATH = path.join(
  repositoryRoot,
  "tests",
  "fixtures",
  "m12-user-env-runtime",
  "digest-server.cjs",
)
const BOOTSTRAP_PATH = path.join(
  repositoryRoot,
  "scripts",
  "gvisor",
  "secret-bootstrap.mjs",
)

const basePlan: BackendRuntimePlan = {
  contractVersion: "backend-v1",
  repository: {
    repositoryId: 1,
    owner: "The-peephole",
    name: "peephole-m12-harness",
    commitSha: "f".repeat(40),
  },
  sourceRoot: ".",
  adapterId: "express-node-npm-v1",
  packageManager: "npm",
  install: { command: "npm", args: ["ci", "--no-audit", "--no-fund"] },
  start: { command: "node", args: [ENTRYPOINT] },
  internalPort: 3000,
  platformEnvironment: {
    PORT: "3000",
    HOST: "0.0.0.0",
    NODE_ENV: "production",
  },
  generatedSecretNames: [],
  databaseRequirement: null,
  userEnvironmentNames: [],
}

interface EnvCheck {
  variables: Record<string, { present: boolean; sha256: string | null }>
  platform: { port: boolean; host: boolean; nodeEnv: boolean }
  argvHasBootstrapFlag: boolean
  argvContainsConfiguredValue: boolean
}

interface M12Environment {
  paths: M12ComponentPaths
  runs: M12RunDirectories
  processRunner: NodeProcessRunner
  leaseManager: NetworkLeaseManager
  diskManager: LoopbackSandboxDiskManager
  sandboxProvisioner: GVisorSandboxProvisioner
  /** What the runtime starter uses (possibly a tampering/failing wrapper). */
  userEnvironmentFilesystem: UserEnvironmentFilesystem
  /** The real, unwrapped tmpfs filesystem for this run's root. */
  realUserEnvironmentFilesystem: TmpfsUserEnvironmentFilesystem
  generatedSecretFilesystem: TmpfsGeneratedSecretFilesystem
  databaseCredentialFilesystem: TmpfsDatabaseCredentialFilesystem
  runtimeStarter: GVisorBackendRuntimeProcess
  handles: RuntimeProcessHandle[]
  workspaces: GVisorPreviewWorkspace[]
}

describe.skipIf(!m12RealSuiteEnabled(process.env))(
  "M12 user-provided environment runtime (real Linux + runsc required)",
  () => {
    let config: M12HarnessConfig
    let protectedRoots: string[]
    let fixtureSource: string

    beforeAll(async () => {
      if (process.platform !== "linux" || process.getuid?.() !== 0) {
        throw new M12HarnessPreflightError(
          "The M12 real-gVisor suite requires Linux and root.",
        )
      }
      const runner = new NodeProcessRunner()
      for (const [command, args] of [
        ["runsc", ["--version"]],
        ["ip", ["-Version"]],
        ["iptables", ["--version"]],
        ["ip6tables", ["--version"]],
        ["findmnt", ["--version"]],
        ["losetup", ["--version"]],
      ] as const) {
        const result = await runner
          .run(command, [...args], { timeoutMs: 10_000 })
          .catch(() => null)
        if (!result || result.exitCode !== 0) {
          throw new M12HarnessPreflightError(
            `The M12 real-gVisor suite requires host command ${command}.`,
          )
        }
      }
      const productionMarkers = await findProductionHostMarkers()
      if (productionMarkers.length > 0) {
        throw new M12HarnessPreflightError(
          `Refusing to run on a host with Peephole production state: ${productionMarkers.join(", ")}.`,
        )
      }
      config = await readM12HarnessConfig(process.env)
      protectedRoots = protectedResourceRoots(process.env)
      const problems = await inspectM12TestRootfs(
        config.baseRootfs,
        await readFile(BOOTSTRAP_PATH),
      )
      if (problems.length > 0) {
        throw new M12HarnessPreflightError(
          `The dedicated test rootfs is not usable: ${problems.join("; ")}.`,
        )
      }
      fixtureSource = await readFile(FIXTURE_PATH, "utf8")
      process.stdout.write(
        `[m12-real-preflight] ${formatM12PreflightSummary(config, process.env)}\n`,
      )
    })

    async function withEnvironment(
      scenario: (environment: M12Environment) => Promise<void>,
      options: {
        staleNetworkOwner?: boolean
        userEnvironmentFilesystem?: (
          inner: TmpfsUserEnvironmentFilesystem,
        ) => UserEnvironmentFilesystem
      } = {},
    ): Promise<void> {
      const runs = await createOwnedRunSet(config)
      const environment = await withSetupRollback(runs, async () => {
        const paths = deriveM12ComponentPaths(config, runs, protectedRoots)
        for (const directory of [
          paths.bundlesRootDir,
          paths.leaseDir,
          paths.runscRootDir,
        ]) {
          await mkdir(directory, { recursive: true, mode: 0o700 })
        }
        // Real findmnt-backed tmpfs proof for each dedicated credential root,
        // plus the M12 rootfs placeholder/bootstrap capability gate.
        await ensureUserEnvironmentCapability({
          rootDir: paths.userEnvironmentRoot,
          baseRootfsImage: paths.baseRootfsImage,
        })
        await ensureGeneratedSecretInjectionCapability({
          secretRootDir: paths.generatedSecretRoot,
          baseRootfsImage: paths.baseRootfsImage,
        })
        await ensureDatabaseCredentialCapability({
          credentialRootDir: paths.databaseCredentialRoot,
        })

        const processRunner = new NodeProcessRunner()
        const leaseManager = new NetworkLeaseManager({
          leaseDir: paths.leaseDir,
          ...(options.staleNetworkOwner
            ? { processState: () => "MISSING" as const }
            : {}),
        })
        const diskManager = new LoopbackSandboxDiskManager({
          bundlesRootDir: paths.bundlesRootDir,
          processRunner,
        })
        const sandboxProvisioner = new GVisorSandboxProvisioner({
          baseRootfsImage: paths.baseRootfsImage,
          bundlesRootDir: paths.bundlesRootDir,
          runscRootDir: paths.runscRootDir,
          processRunner,
          networkProvisioner: new VethNatNetworkProvisioner({
            processRunner,
            leaseManager,
          }),
          diskManager,
        })
        const realUserFilesystem = new TmpfsUserEnvironmentFilesystem({
          rootDir: paths.userEnvironmentRoot,
          forbiddenRoots: [paths.bundlesRootDir],
        })
        const userEnvironmentFilesystem =
          options.userEnvironmentFilesystem?.(realUserFilesystem) ??
          realUserFilesystem
        const generatedSecretFilesystem = new TmpfsGeneratedSecretFilesystem({
          rootDir: paths.generatedSecretRoot,
          forbiddenRoots: [paths.bundlesRootDir],
        })
        const databaseCredentialFilesystem =
          new TmpfsDatabaseCredentialFilesystem({
            rootDir: paths.databaseCredentialRoot,
            forbiddenRoots: [paths.bundlesRootDir, paths.generatedSecretRoot],
          })
        const environment: M12Environment = {
          paths,
          runs,
          processRunner,
          leaseManager,
          diskManager,
          sandboxProvisioner,
          userEnvironmentFilesystem,
          realUserEnvironmentFilesystem: realUserFilesystem,
          generatedSecretFilesystem,
          databaseCredentialFilesystem,
          runtimeStarter: new GVisorBackendRuntimeProcess({
            runscRootDir: paths.runscRootDir,
            processRunner,
            maxRuntimeMs: 120_000,
            userEnvironmentFilesystem,
            generatedSecretFilesystem,
            databaseCredentialFilesystem,
          }),
          handles: [],
          workspaces: [],
        }
        return environment
      })

      await runWithOwnedCleanup(
        () => scenario(environment),
        [
          // Every step runs; any failure fails the test (Finding 1), and
          // removeRunsIfClean then preserves whatever is not provably clean.
          () => stopRuntimeHandles(environment.handles),
          () => destroyWorkspaces(environment.workspaces),
          () => removeRunsIfClean(environment),
        ],
      )
    }

    async function allocateWithFixture(
      environment: M12Environment,
      label: string,
      entrypointSource = fixtureSource,
    ): Promise<GVisorPreviewWorkspace> {
      const workspace = await environment.sandboxProvisioner.allocate(
        `m12-${label}-${randomUUID().slice(0, 8)}`,
      )
      environment.workspaces.push(workspace)
      await writeFile(
        path.join(workspace.rootDir, ENTRYPOINT),
        entrypointSource,
      )
      await workspace.normalizeExtractedTree()
      return workspace
    }

    it("E1: delivers one user-provided value only through the tmpfs mount and cleans it after stop", async () => {
      await withEnvironment(async (environment) => {
        const workspace = await allocateWithFixture(environment, "e1")
        const plan = { ...basePlan, userEnvironmentNames: ["APP_GREETING"] }
        const material = takeUserMaterial(workspace.id, [
          { name: "APP_GREETING", value: SYNTHETIC_VALUE },
        ])
        const handle = await environment.runtimeStarter.start(
          workspace,
          plan,
          null,
          null,
          material,
        )
        environment.handles.push(handle)
        await handle.waitUntilReady(30_000)

        const check = await envCheck(handle)
        expect(check.variables.APP_GREETING).toEqual({
          present: true,
          sha256: sha256(SYNTHETIC_VALUE),
        })
        expect(check.platform).toEqual({
          port: true,
          host: true,
          nodeEnv: true,
        })
        expect(check.argvHasBootstrapFlag).toBe(false)
        expect(check.argvContainsConfiguredValue).toBe(false)

        const config = await readConfig(workspace)
        expect(config.process.env).toEqual([
          "PORT=3000",
          "HOST=0.0.0.0",
          "NODE_ENV=production",
        ])
        expect(config.process.args).toEqual([
          SANDBOX_NODE_BINARY,
          SANDBOX_SECRET_BOOTSTRAP,
          SANDBOX_USER_ENVIRONMENT_BOOTSTRAP_FLAG,
          ENTRYPOINT,
        ])
        expect(secretMountDestinations(config)).toEqual([
          "/run/secrets/user-env",
        ])

        const runtimeDir = path.join(
          environment.paths.userEnvironmentRoot,
          workspace.id,
        )
        const dirStats = await lstat(runtimeDir)
        const fileStats = await lstat(
          path.join(runtimeDir, USER_ENVIRONMENT_FILE_NAME),
        )
        expect([dirStats.mode & 0o777, dirStats.uid, dirStats.gid]).toEqual([
          0o700,
          SANDBOX_UID,
          SANDBOX_GID,
        ])
        expect([fileStats.mode & 0o777, fileStats.uid, fileStats.gid]).toEqual([
          0o600,
          SANDBOX_UID,
          SANDBOX_GID,
        ])

        const active = await persistenceStatus(environment, workspace, [
          SYNTHETIC_VALUE,
        ])
        await handle.stop()
        await handle.stop()
        await handle.waitForExit()
        environment.handles.splice(environment.handles.indexOf(handle), 1)
        await expect(lstat(runtimeDir)).rejects.toThrow()
        const postStop = await persistenceStatus(environment, workspace, [
          SYNTHETIC_VALUE,
        ])
        expect({ active, postStop }).toEqual({
          active: "PASS",
          postStop: "PASS",
        })
        evidence("E1", {
          digestMatch: true,
          active,
          postStop,
          tmpfsCleanup: true,
        })
      })
    }, 120_000)

    it("E2: M10 + M12 deliver independent files without collision", async () => {
      await withEnvironment(async (environment) => {
        const workspace = await allocateWithFixture(environment, "e2")
        const secrets = takeGeneratedSecret(workspace.id)
        const sessionValue = secrets.values.get("SESSION_SECRET")!.reveal()
        const handle = await environment.runtimeStarter.start(
          workspace,
          {
            ...basePlan,
            generatedSecretNames: ["SESSION_SECRET"],
            userEnvironmentNames: ["APP_GREETING"],
          },
          secrets,
          null,
          takeUserMaterial(workspace.id, [
            { name: "APP_GREETING", value: SYNTHETIC_VALUE },
          ]),
        )
        environment.handles.push(handle)
        await handle.waitUntilReady(30_000)
        const check = await envCheck(handle)
        expect(check.variables.APP_GREETING?.sha256).toBe(
          sha256(SYNTHETIC_VALUE),
        )
        expect(check.variables.SESSION_SECRET?.sha256).toBe(
          sha256(sessionValue),
        )
        expect(check.variables.SESSION_SECRET?.sha256).not.toBe(
          check.variables.APP_GREETING?.sha256,
        )
        expect(secretMountDestinations(await readConfig(workspace))).toEqual([
          "/run/secrets/env",
          "/run/secrets/user-env",
        ])
        const active = await persistenceStatus(environment, workspace, [
          SYNTHETIC_VALUE,
          sessionValue,
        ])
        await stopAndRelease(environment, handle)
        await expectEmpty(environment.paths.userEnvironmentRoot)
        await expectEmpty(environment.paths.generatedSecretRoot)
        expect(active).toBe("PASS")
        evidence("E2", { digestsMatch: true, independentMounts: true, active })
      })
    }, 120_000)

    it("E3: M11 (synthetic DATABASE_URL, no PostgreSQL) + M12 mount independently", async () => {
      await withEnvironment(async (environment) => {
        const workspace = await allocateWithFixture(environment, "e3")
        const database = syntheticDatabaseCredential(workspace.id)
        const databaseUrl = database.databaseUrl.reveal()
        const handle = await environment.runtimeStarter.start(
          workspace,
          {
            ...basePlan,
            databaseRequirement: { name: "DATABASE_URL" },
            userEnvironmentNames: ["APP_GREETING"],
          },
          null,
          database,
          takeUserMaterial(workspace.id, [
            { name: "APP_GREETING", value: SYNTHETIC_VALUE },
          ]),
        )
        environment.handles.push(handle)
        await handle.waitUntilReady(30_000)
        const check = await envCheck(handle)
        expect(check.variables.APP_GREETING?.sha256).toBe(
          sha256(SYNTHETIC_VALUE),
        )
        expect(check.variables.DATABASE_URL?.sha256).toBe(sha256(databaseUrl))
        expect(secretMountDestinations(await readConfig(workspace))).toEqual([
          "/run/secrets/database-url",
          "/run/secrets/user-env",
        ])
        const active = await persistenceStatus(environment, workspace, [
          SYNTHETIC_VALUE,
          databaseUrl,
        ])
        await stopAndRelease(environment, handle)
        await expectEmpty(environment.paths.userEnvironmentRoot)
        await expectEmpty(environment.paths.databaseCredentialRoot)
        expect(active).toBe("PASS")
        evidence("E3-mounts", {
          digestsMatch: true,
          independentMounts: true,
          active,
          databaseConnectivity: "NOT_RUN",
        })
      })
    }, 120_000)

    it("E4: M10 + M11 (synthetic) + M12 coexist as three independent files", async () => {
      await withEnvironment(async (environment) => {
        const workspace = await allocateWithFixture(environment, "e4")
        const secrets = takeGeneratedSecret(workspace.id)
        const sessionValue = secrets.values.get("SESSION_SECRET")!.reveal()
        const database = syntheticDatabaseCredential(workspace.id)
        const databaseUrl = database.databaseUrl.reveal()
        const handle = await environment.runtimeStarter.start(
          workspace,
          {
            ...basePlan,
            generatedSecretNames: ["SESSION_SECRET"],
            databaseRequirement: { name: "DATABASE_URL" },
            userEnvironmentNames: ["APP_GREETING", "FEATURE_MODE"],
          },
          secrets,
          database,
          takeUserMaterial(workspace.id, [
            { name: "APP_GREETING", value: SYNTHETIC_VALUE },
            { name: "FEATURE_MODE", value: SECOND_SYNTHETIC_VALUE },
          ]),
        )
        environment.handles.push(handle)
        await handle.waitUntilReady(30_000)
        const check = await envCheck(handle)
        expect(
          Object.fromEntries(
            Object.entries(check.variables).map(([name, value]) => [
              name,
              value.sha256,
            ]),
          ),
        ).toEqual({
          APP_GREETING: sha256(SYNTHETIC_VALUE),
          FEATURE_MODE: sha256(SECOND_SYNTHETIC_VALUE),
          SESSION_SECRET: sha256(sessionValue),
          DATABASE_URL: sha256(databaseUrl),
        })
        expect(secretMountDestinations(await readConfig(workspace))).toEqual([
          "/run/secrets/env",
          "/run/secrets/database-url",
          "/run/secrets/user-env",
        ])
        const active = await persistenceStatus(environment, workspace, [
          SYNTHETIC_VALUE,
          SECOND_SYNTHETIC_VALUE,
          sessionValue,
          databaseUrl,
        ])
        await stopAndRelease(environment, handle)
        for (const root of [
          environment.paths.userEnvironmentRoot,
          environment.paths.generatedSecretRoot,
          environment.paths.databaseCredentialRoot,
        ]) {
          await expectEmpty(root)
        }
        expect(active).toBe("PASS")
        evidence("E4-mounts", {
          digestsMatch: true,
          active,
          databaseConnectivity: "NOT_RUN",
        })
      })
    }, 120_000)

    it("E5: a backend without user configuration keeps the previous runtime path", async () => {
      await withEnvironment(async (environment) => {
        const workspace = await allocateWithFixture(environment, "e5")
        const handle = await environment.runtimeStarter.start(
          workspace,
          basePlan,
        )
        environment.handles.push(handle)
        await handle.waitUntilReady(30_000)
        const check = await envCheck(handle)
        expect(check.variables.APP_GREETING?.present).toBe(false)
        const config = await readConfig(workspace)
        expect(config.process.args).toEqual([SANDBOX_NODE_BINARY, ENTRYPOINT])
        expect(secretMountDestinations(config)).toEqual([])
        await stopAndRelease(environment, handle)
        await expectEmpty(environment.paths.userEnvironmentRoot)
        evidence("E5", { previousPath: true })
      })
    }, 120_000)

    it("G1: natural process exit removes the user-env file", async () => {
      await withEnvironment(async (environment) => {
        const workspace = await allocateWithFixture(environment, "g1")
        const handle = await environment.runtimeStarter.start(
          workspace,
          { ...basePlan, userEnvironmentNames: ["APP_GREETING"] },
          null,
          null,
          takeUserMaterial(workspace.id, [
            { name: "APP_GREETING", value: SYNTHETIC_VALUE },
          ]),
        )
        environment.handles.push(handle)
        await handle.waitUntilReady(30_000)
        await getJson(handle, "/exit")
        await handle.waitForExit()
        await expectEmpty(environment.paths.userEnvironmentRoot)
        evidence("G1", { naturalExitCleanup: true })
      })
    }, 120_000)

    it("G2: a startup failure never becomes ready and still removes the file", async () => {
      await withEnvironment(async (environment) => {
        const workspace = await allocateWithFixture(
          environment,
          "g2",
          "process.exit(3)\n",
        )
        const handle = await environment.runtimeStarter.start(
          workspace,
          { ...basePlan, userEnvironmentNames: ["APP_GREETING"] },
          null,
          null,
          takeUserMaterial(workspace.id, [
            { name: "APP_GREETING", value: SYNTHETIC_VALUE },
          ]),
        )
        environment.handles.push(handle)
        await expect(handle.waitUntilReady(30_000)).rejects.toBeInstanceOf(
          BackendRuntimeExitedBeforeReadyError,
        )
        await handle.waitForExit()
        await expectEmpty(environment.paths.userEnvironmentRoot)
        evidence("G2", { neverReady: true, cleanup: true })
      })
    }, 120_000)

    it.each([
      ["missing (emptied) user-env material", ""],
      ["malformed user-env material", "{not json}\n"],
    ])(
      "G3: the trusted bootstrap fails closed on %s and the backend never becomes ready",
      async (label, replacement) => {
        await withEnvironment(
          async (environment) => {
            const workspace = await allocateWithFixture(environment, "g3")
            const handle = await environment.runtimeStarter.start(
              workspace,
              { ...basePlan, userEnvironmentNames: ["APP_GREETING"] },
              null,
              null,
              takeUserMaterial(workspace.id, [
                { name: "APP_GREETING", value: SYNTHETIC_VALUE },
              ]),
            )
            environment.handles.push(handle)
            await expect(handle.waitUntilReady(30_000)).rejects.toBeInstanceOf(
              BackendRuntimeExitedBeforeReadyError,
            )
            const exit = await handle.waitForExit()
            expect(exit.exitCode).not.toBe(0)
            await expectEmpty(environment.paths.userEnvironmentRoot)
            evidence("G3", { case: label, failClosed: true, cleanup: true })
          },
          {
            // Test-owned tampering of this run's own just-written file.
            userEnvironmentFilesystem: (inner) => ({
              rootDir: inner.rootDir,
              create: async (material) => {
                const file = await inner.create(material)
                await writeFile(file, replacement)
                return file
              },
              remove: (runtimeId) => inner.remove(runtimeId),
            }),
          },
        )
      },
      120_000,
    )

    it("G4: a failing M12 cleanup never prevents M10 cleanup", async () => {
      let failNextRemove = true
      await withEnvironment(
        async (environment) => {
          const workspace = await allocateWithFixture(environment, "g4")
          const handle = await environment.runtimeStarter.start(
            workspace,
            {
              ...basePlan,
              generatedSecretNames: ["SESSION_SECRET"],
              userEnvironmentNames: ["APP_GREETING"],
            },
            takeGeneratedSecret(workspace.id),
            null,
            takeUserMaterial(workspace.id, [
              { name: "APP_GREETING", value: SYNTHETIC_VALUE },
            ]),
          )
          environment.handles.push(handle)
          await handle.waitUntilReady(30_000)
          await expect(handle.stop()).rejects.toThrow()
          environment.handles.splice(environment.handles.indexOf(handle), 1)
          await expectEmpty(environment.paths.generatedSecretRoot)
          // The M12 file survived its own failed cleanup; remove it through
          // the real filesystem's ownership-checked path.
          await environment.realUserEnvironmentFilesystem.remove(workspace.id)
          await expectEmpty(environment.paths.userEnvironmentRoot)
          evidence("G4", { independentCleanup: true })
        },
        {
          userEnvironmentFilesystem: (inner) => ({
            rootDir: inner.rootDir,
            create: (material) => inner.create(material),
            remove: async (runtimeId) => {
              if (failNextRemove) {
                failNextRemove = false
                throw new Error("Injected M12 cleanup failure.")
              }
              await inner.remove(runtimeId)
            },
          }),
        },
      )
    }, 120_000)

    it("G5: the real tmpfs reaper removes only stale test-owned entries", async () => {
      await withEnvironment(async (environment) => {
        const filesystem = environment.realUserEnvironmentFilesystem
        for (const runtimeId of ["m12-stale-aaaa", "m12-fresh-bbbb"]) {
          await filesystem.create(
            takeUserMaterial(runtimeId, [
              { name: "APP_GREETING", value: SYNTHETIC_VALUE },
            ]),
          )
        }
        const past = new Date(Date.now() - 60 * 60_000)
        await utimes(
          path.join(environment.paths.userEnvironmentRoot, "m12-stale-aaaa"),
          past,
          past,
        )
        const unrelated = path.join(
          environment.paths.userEnvironmentRoot,
          "not_a_runtime_id",
        )
        await mkdir(unrelated)
        const reaper = new UserEnvironmentOrphanReaper({
          rootDir: environment.paths.userEnvironmentRoot,
          filesystem,
          maxAgeMs: 30 * 60_000,
        })
        expect(await reaper.reap()).toEqual(["m12-stale-aaaa"])
        expect(await reaper.reapAll()).toEqual(["m12-fresh-bbbb"])
        expect(await reaper.reapAll()).toEqual([])
        await expect(lstat(unrelated)).resolves.toBeTruthy()
        evidence("G5", { staleReaped: true, unrelatedPreserved: true })
      })
    }, 60_000)

    it(
      "G6: confirms natural exit and cleanup while the scoped SIGTERM runner request is pending",
      safeRealTest(async () => {
        let signalExitCode: number | null = null
        await withEnvironment(async (environment) => {
          const workspace = await allocateWithFixture(environment, "g6")
          const boundary = new PendingSignalProcessRunner(
            environment.processRunner,
            environment.paths.runscRootDir,
          )
          const runtime = new GVisorBackendRuntimeProcess({
            runscRootDir: environment.paths.runscRootDir,
            processRunner: boundary,
            maxRuntimeMs: 120_000,
            generatedSecretFilesystem: environment.generatedSecretFilesystem,
            databaseCredentialFilesystem:
              environment.databaseCredentialFilesystem,
            userEnvironmentFilesystem: environment.userEnvironmentFilesystem,
          })
          const handle = await runtime.start(
            workspace,
            {
              ...basePlan,
              generatedSecretNames: ["SESSION_SECRET"],
              databaseRequirement: { name: "DATABASE_URL" },
              userEnvironmentNames: ["APP_GREETING"],
            },
            takeGeneratedSecret(workspace.id),
            syntheticDatabaseCredential(workspace.id),
            takeUserMaterial(workspace.id, [
              { name: "APP_GREETING", value: SYNTHETIC_VALUE },
            ]),
          )
          environment.handles.push(handle)
          await handle.waitUntilReady(30_000)
          expect(workspace.listContainers()).toHaveLength(1)
          boundary.arm(workspace.listContainers()[0]!)
          const stopped = handle.stop().then(
            () => true,
            () => false,
          )
          try {
            await boundary.waitUntilPending()
            expect(boundary.delegated).toBe(false)
            // The fixture exits itself. No host signal has been delegated.
            await getJson(handle, "/exit")
            expect(await handle.waitForExit()).toEqual({ exitCode: 0 })
            expect(boundary.pending).toBe(true)
            expect(workspace.listContainers()).toEqual([])
            await expectEmpty(environment.paths.generatedSecretRoot)
            await expectEmpty(environment.paths.databaseCredentialRoot)
            await expectEmpty(environment.paths.userEnvironmentRoot)
          } finally {
            // Even a failed assertion must unblock the existing owned cleanup.
            boundary.release()
            await stopped
          }
          expect(await stopped).toBe(true)
          // This is the real NodeProcessRunner/runsc result, never a fabricated
          // "not found". Null exit/timeout cannot attest this boundary.
          expect(boundary.signalResult?.timedOut).toBe(false)
          signalExitCode = boundary.signalResult?.exitCode ?? null
          expect(signalExitCode !== null && signalExitCode !== 0).toBe(true)
          await handle.stop()
          expect(await handle.waitForExit()).toEqual({ exitCode: 0 })
        })
        // Emit only after the scenario AND outer owned-resource cleanup pass.
        evidence("G6-pending-signal", {
          execution: "REAL_GVISOR",
          runnerBoundaryReached: true,
          naturalExitCode: 0,
          signalExitCode,
          independentMaterialCleanup: true,
          ownedCleanup: true,
          databaseConnectivity: "NOT_RUN",
          journal: "NOT_RUN",
        })
      }),
      120_000,
    )

    it("H2/H3: after supervisor ownership loss, fresh reapers clean every test-owned resource, idempotently", async () => {
      await withEnvironment(
        async (environment) => {
          const workspace = await allocateWithFixture(environment, "h2")
          const handle = await environment.runtimeStarter.start(
            workspace,
            { ...basePlan, userEnvironmentNames: ["APP_GREETING"] },
            null,
            null,
            takeUserMaterial(workspace.id, [
              { name: "APP_GREETING", value: SYNTHETIC_VALUE },
            ]),
          )
          // Tracked until the reapers succeed, so a failed assertion before
          // that point still stops it in cleanup.
          environment.handles.push(handle)
          await handle.waitUntilReady(30_000)
          expect((await envCheck(handle)).variables.APP_GREETING?.sha256).toBe(
            sha256(SYNTHETIC_VALUE),
          )
          const decoy = path.join(
            environment.paths.userEnvironmentRoot,
            "not_a_runtime_id",
          )
          await mkdir(decoy)

          // The supervisor's in-memory handle is abandoned (no stop, no
          // destroy): only fresh, test-root-scoped reapers may clean up.
          const diskReaper = new GVisorOrphanReaper({
            runscRootDir: environment.paths.runscRootDir,
            bundlesRootDir: environment.paths.bundlesRootDir,
            diskManager: environment.diskManager,
            processRunner: environment.processRunner,
          })
          const networkReaper = new NetworkOrphanReaper({
            leaseManager: environment.leaseManager,
            processRunner: environment.processRunner,
          })
          const userReaper = new UserEnvironmentOrphanReaper({
            rootDir: environment.paths.userEnvironmentRoot,
            filesystem: environment.realUserEnvironmentFilesystem,
          })
          expect(await diskReaper.reapAll()).toHaveLength(1)
          await networkReaper.reapAll()
          // The dead supervisor never removed its file (its filesystem's
          // remove is a no-op below), so only the fresh reaper can.
          expect(await userReaper.reapAll()).toEqual([workspace.id])
          expect(await diskReaper.reapAll()).toEqual([])
          await networkReaper.reapAll()
          expect(await userReaper.reapAll()).toEqual([])
          expect(await readdir(environment.paths.userEnvironmentRoot)).toEqual([
            "not_a_runtime_id",
          ])
          expect(await environment.diskManager.listOwnedAllocations()).toEqual(
            [],
          )
          expect(await environment.leaseManager.listOwnedLeases()).toEqual([])
          // The abandoned handle and workspace were reclaimed by the reapers.
          environment.handles.splice(environment.handles.indexOf(handle), 1)
          environment.workspaces.splice(
            environment.workspaces.indexOf(workspace),
            1,
          )
          evidence("H2-H3", {
            reconciled: true,
            repeated: true,
            decoyPreserved: true,
          })
          // Deliberately never stop/destroy/waitForExit the abandoned handle.
          void handle
        },
        {
          staleNetworkOwner: true,
          // Models a crashed supervisor: it can no longer clean anything.
          userEnvironmentFilesystem: (inner) => ({
            rootDir: inner.rootDir,
            create: (material) => inner.create(material),
            remove: async () => undefined,
          }),
        },
      )
    }, 120_000)

    // ------------------------------------------------------------ helpers

    async function persistenceStatus(
      environment: M12Environment,
      workspace: GVisorPreviewWorkspace,
      rawValues: readonly string[],
    ): Promise<ScanStatus> {
      const statuses: ScanStatus[] = []
      for (const rawValue of rawValues) {
        statuses.push(
          await scanFileForRawValueStatus(
            path.join(workspace.bundleDir, "config.json"),
            rawValue,
          ),
        )
        statuses.push(
          await scanRunscStateForRawValue(
            environment.paths.runscRootDir,
            rawValue,
          ).then(
            (result): ScanStatus => (result.found ? "FAIL" : "PASS"),
            (): ScanStatus => "INCOMPLETE",
          ),
        )
        statuses.push(await scanForRawValueStatus(workspace.rootDir, rawValue))
        statuses.push(
          await scanForRawValueStatus(environment.paths.leaseDir, rawValue),
        )
      }
      return combineScanStatuses(statuses)
    }

    async function stopAndRelease(
      environment: M12Environment,
      handle: RuntimeProcessHandle,
    ): Promise<void> {
      await handle.stop()
      await handle.waitForExit()
      environment.handles.splice(environment.handles.indexOf(handle), 1)
    }
  },
)

/** Preserves every run directory unless the environment is provably clean
 * and each run directory still passes its ownership re-check. */
async function removeRunsIfClean(environment: M12Environment): Promise<void> {
  const [allocations, leases, containers] = await Promise.all([
    environment.diskManager.listOwnedAllocations(),
    environment.leaseManager.listOwnedLeases(),
    listRunscContainers(
      environment.processRunner,
      environment.paths.runscRootDir,
    ),
  ])
  const preserved: string[] = []
  if (allocations.length > 0 || leases.length > 0 || containers.length > 0) {
    throw new Error(
      `M12 harness cleanup is incomplete; preserving ${Object.values(
        environment.runs,
      )
        .map((run) => run.path)
        .join(", ")} for manual review.`,
    )
  }
  const reconciled = await reconcileDedicatedRunscStateForCleanup(
    environment.paths.runscRootDir,
  )
  if (!reconciled.ok) {
    preserved.push(`${environment.runs.runsc.path} (${reconciled.reason})`)
  } else {
    const outcome = await removeOwnedRunDirectory(environment.runs.runsc)
    if (!outcome.removed) {
      preserved.push(`${environment.runs.runsc.path} (${outcome.reason})`)
    }
  }
  for (const run of [environment.runs.workspace, environment.runs.tmpfs]) {
    const outcome = await removeOwnedRunDirectory(run)
    if (!outcome.removed) preserved.push(`${run.path} (${outcome.reason})`)
  }
  if (preserved.length > 0) {
    throw new Error(
      `M12 harness preserved unverifiable resources: ${preserved.join("; ")}.`,
    )
  }
}

function takeUserMaterial(
  runtimeId: string,
  entries: UserEnvironmentEntry[],
): UserEnvironmentMaterial {
  const broker = new InMemoryUserEnvironmentBroker()
  const previewId = `fullstack-${randomUUID()}`
  const sorted = [...entries].sort((left, right) =>
    left.name < right.name ? -1 : 1,
  )
  const names = sorted.map((entry) => entry.name)
  broker.register(
    {
      previewId,
      requesterId: "github:m12-real-harness",
      repository: basePlan.repository,
      backendSourceRoot: ".",
      names,
    },
    sorted,
    new Date(Date.now() + 60_000),
  )
  const material = broker.take(previewId, {
    runtimeId,
    repository: basePlan.repository,
    backendSourceRoot: ".",
    names,
  })
  if (!material) throw new Error("Expected admitted user environment material.")
  return material
}

function takeGeneratedSecret(runtimeId: string) {
  const broker = new InMemoryBackendRuntimeSecretBroker()
  broker.issue(runtimeId, ["SESSION_SECRET"])
  const material = broker.take(runtimeId)
  if (!material) throw new Error("Expected generated secret material.")
  return material
}

/** A synthetic, never-provisioned credential in the exact canonical shape:
 * proves mount coexistence only, never database connectivity. */
function syntheticDatabaseCredential(runtimeId: string) {
  const resourceId = mintTemporaryDatabaseResourceId()
  const objectName = deriveTemporaryDatabaseObjectName(resourceId)
  return {
    runtimeId,
    resourceId,
    databaseUrl: buildTemporaryDatabaseUrl({
      resourceId,
      databaseName: objectName,
      roleName: objectName,
      password: generatePreviewSecretValue(),
    }),
  }
}

async function readConfig(workspace: GVisorPreviewWorkspace): Promise<{
  process: { env: string[]; args: string[] }
  mounts: Array<{ destination: string }>
}> {
  return JSON.parse(
    await readFile(path.join(workspace.bundleDir, "config.json"), "utf8"),
  ) as {
    process: { env: string[]; args: string[] }
    mounts: Array<{ destination: string }>
  }
}

function secretMountDestinations(config: {
  mounts: Array<{ destination: string }>
}): string[] {
  return config.mounts
    .map((mount) => mount.destination)
    .filter((destination) => destination.startsWith("/run/secrets/"))
}

async function expectEmpty(directory: string): Promise<void> {
  expect(await readdir(directory)).toEqual([])
}

async function envCheck(handle: RuntimeProcessHandle): Promise<EnvCheck> {
  return (await getJson(handle, "/env-check")) as EnvCheck
}

function getJson(
  handle: RuntimeProcessHandle,
  requestPath: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = httpGet(
      {
        host: handle.dialTarget.host,
        port: handle.dialTarget.port,
        path: requestPath,
        timeout: 5_000,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.once("error", reject)
        response.once("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
          } catch {
            reject(new Error("The fixture returned a non-JSON response."))
          }
        })
      },
    )
    request.once("timeout", () => request.destroy(new Error("HTTP timeout")))
    request.once("error", reject)
  })
}

async function listRunscContainers(
  runner: NodeProcessRunner,
  runscRootDir: string,
): Promise<string[]> {
  const result = await runner.run(
    "runsc",
    ["--root", runscRootDir, "list", "--format", "json"],
    { timeoutMs: 10_000 },
  )
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error("runsc list failed for the dedicated test root.")
  }
  const parsed = JSON.parse(result.stdout) as unknown
  if (parsed === null) return []
  if (!Array.isArray(parsed)) throw new Error("runsc list returned non-array.")
  return parsed.map((entry) => String((entry as { id?: unknown }).id))
}

/** Booleans and statuses only -- never a raw value. */
function evidence(scenario: string, record: Record<string, unknown>): void {
  process.stdout.write(
    `[m12-real-evidence] ${JSON.stringify({ scenario, ...record })}\n`,
  )
}
