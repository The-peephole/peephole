import { createHash, randomUUID } from "node:crypto"
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises"
import { createServer, get as httpGet } from "node:http"
import { createConnection } from "node:net"
import path from "node:path"
import { describe, expect, it } from "vitest"

import {
  buildTemporaryDatabaseUrl,
  TENANT_DATABASE_HOST,
  TENANT_DATABASE_PORT,
} from "../core/backendDatabase/databaseUrl"
import {
  deriveTemporaryDatabaseObjectName,
  mintTemporaryDatabaseResourceId,
  type TemporaryDatabaseResourceId,
} from "../core/backendDatabase/resourceIdentity"
import { generatePreviewSecretValue } from "../core/backendSecrets/generatedSecretValue"
import { BackendRuntimeControlPlane } from "../services/backend-runtime-api/controlPlane"
import {
  InMemoryBackendRuntimeQueue,
  InMemoryBackendRuntimeStore,
} from "../services/backend-runtime-api/inMemoryAdapters"
import { BackendRuntimeSupervisor } from "../services/backend-runtime-worker/backendRuntimeSupervisor"
import { LiveBackendRuntimeRegistry } from "../services/backend-runtime-worker/liveRuntimeRegistry"
import type { RuntimeProcessHandle } from "../services/backend-runtime-worker/ports"
import {
  DEFAULT_DATABASE_CREDENTIAL_ROOT,
  DATABASE_CREDENTIAL_FILE_NAME,
  listOwnedDatabaseCredentialRuntimeIds,
  SANDBOX_DATABASE_CREDENTIAL_FILE,
  TmpfsDatabaseCredentialFilesystem,
} from "../services/preview-worker/gvisor/databaseCredentialFilesystem"
import { GVisorBackendRuntimeProcess } from "../services/preview-worker/gvisor/backendRuntimeProcess"
import { GVisorSandboxProvisioner } from "../services/preview-worker/gvisor/gvisorSandboxProvisioner"
import type { GVisorPreviewWorkspace } from "../services/preview-worker/gvisor/gvisorWorkspace"
import { VethNatNetworkProvisioner } from "../services/preview-worker/gvisor/networkNamespace"
import { NodeProcessRunner } from "../services/preview-worker/gvisor/nodeProcessRunner"
import { LoopbackSandboxDiskManager } from "../services/preview-worker/gvisor/sandboxDisk"
import {
  SANDBOX_GID,
  SANDBOX_SECRET_BOOTSTRAP,
  SANDBOX_UID,
} from "../services/preview-worker/gvisor/sandboxIdentity"
import {
  NetworkLeaseManager,
  type NetworkLease,
} from "../services/preview-worker/gvisor/subnetAllocator"
import { ArchiveByteStore } from "../services/preview-worker/local/archiveByteStore"
import { ExtractionState } from "../services/preview-worker/local/extractionState"
import type { CommandRunner } from "../services/preview-worker/local/commandRunner"
import type { SandboxProvisioner } from "../services/preview-worker/ports"
import { PostgresTemporaryDatabasePhysicalCleaner } from "../services/temporary-database/temporaryDatabasePhysicalCleaner"
import { PostgresTenantAdmin } from "../services/temporary-database/postgresTenantAdmin"
import { PostgresTemporaryDatabaseTenantCatalog } from "../services/temporary-database/postgresTenantCatalog"
import type {
  CreateTemporaryDatabaseOwnership,
  TemporaryDatabaseOwnershipStore,
  TemporaryDatabaseReconciliationSourceStatus,
} from "../services/temporary-database/ports"
import { readProvisioningSessionPolicy } from "../services/temporary-database/tenantSessionPolicy"
import { TemporaryDatabaseProvisioner } from "../services/temporary-database/temporaryDatabaseProvisioner"
import type {
  BackendRuntimePlan,
  QueuedBackendRuntime,
} from "../types/backendRuntime"
import type {
  TemporaryDatabaseRecord,
  TemporaryDatabaseStatus,
} from "../types/temporaryDatabase"
import { createRealGvisorTestDirectory } from "./support/realGvisorTestRoot"
import {
  removeDedicatedTestRootIfReconciled,
  scanRunscStateForRawValue,
} from "./support/realRunscStateInspection"

const REAL_GVISOR_GATE = "PEEPHOLE_REAL_GVISOR_TESTS"
const M11_DATABASE_GATE = "PEEPHOLE_M11_REAL_GVISOR_DATABASE_TESTS"
const M11_POSTGRES_URL = "PEEPHOLE_M11_REAL_GVISOR_POSTGRES_URL"
const BASE_ROOTFS_ENV = "PEEPHOLE_GVISOR_BASE_ROOTFS"
const PRODUCTION_BASE_ROOTFS = "/var/lib/peephole/base-rootfs"
const DATABASE_TEST_PARENT_DIR = "/run/peephole"

const repository = {
  repositoryId: 1,
  owner: "peephole-m11-test",
  name: "real-temporary-database",
  commitSha: "d".repeat(40),
}

const databasePlan: BackendRuntimePlan = {
  contractVersion: "backend-v1",
  repository,
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
  databaseRequirement: { name: "DATABASE_URL" },
}

const otherJobPlan: BackendRuntimePlan = {
  ...databasePlan,
  sourceRoot: ".",
  start: { command: "node", args: ["other-server.js"] },
  internalPort: 3001,
  platformEnvironment: {
    PORT: "3001",
    HOST: "0.0.0.0",
    NODE_ENV: "production",
  },
  databaseRequirement: null,
}

interface RealDatabaseEnvironment {
  rootDir: string
  bundlesRootDir: string
  runscRootDir: string
  credentialRoot: string
  processRunner: NodeProcessRunner
  leaseManager: NetworkLeaseManager
  networkProvisioner: VethNatNetworkProvisioner
  diskManager: LoopbackSandboxDiskManager
  sandboxProvisioner: GVisorSandboxProvisioner
  runtimeStarter: GVisorBackendRuntimeProcess
}

interface ProbeResult {
  connected: boolean
  error: string | null
}

interface ChildProof {
  configured: boolean
  sha256: string | null
  routes: string
  attempts: Record<string, ProbeResult>
}

describe("M11 real-gVisor database safety gates", () => {
  it.each(["", "0", "false", "yes", "true"])(
    "does not enable for a non-exact opt-in value",
    (value) => {
      expect(
        realDatabaseSuiteEnabled({
          [REAL_GVISOR_GATE]: value,
          [M11_DATABASE_GATE]: "1",
        }),
      ).toBe(false)
      expect(
        realDatabaseSuiteEnabled({
          [REAL_GVISOR_GATE]: "1",
          [M11_DATABASE_GATE]: value,
        }),
      ).toBe(false)
    },
  )

  it("requires both exact opt-ins", () => {
    expect(
      realDatabaseSuiteEnabled({
        [REAL_GVISOR_GATE]: "1",
        [M11_DATABASE_GATE]: "1",
      }),
    ).toBe(true)
  })
})

describe.skipIf(!realDatabaseSuiteEnabled(process.env))(
  "M11 temporary database runtime (real Linux + runsc + PostgreSQL 18 required)",
  () => {
    it("proves the integrated database lifecycle, exact network exception, credential isolation, and zero residue", async () => {
      const config = readRequiredConfiguration(process.env)
      const processRunner = new NodeProcessRunner()
      await assertHostPrerequisites(processRunner, config.baseRootfsImage)

      const tenantAdmin = new PostgresTenantAdmin({
        connectionString: config.postgresUrl,
        max: 2,
      })
      const cleanupErrors: unknown[] = []
      let scenarioError: unknown
      let environment: RealDatabaseEnvironment | undefined
      let otherWorkspace: GVisorPreviewWorkspace | undefined
      let otherHandle: RuntimeProcessHandle | undefined
      let primaryWorkspace: GVisorPreviewWorkspace | undefined
      let primaryLease: NetworkLease | undefined
      let otherLease: NetworkLease | undefined
      let hostControlPlane: ReturnType<typeof createServer> | undefined
      let supervisorRun: Promise<void> | undefined
      let controlPlane: BackendRuntimeControlPlane | undefined
      let requesterSubject: string | undefined
      let runtimeId: string | undefined
      let resourceId: TemporaryDatabaseResourceId | undefined
      let ownershipStore: TestOwnershipStore | undefined
      let physicalCleaner: PostgresTemporaryDatabasePhysicalCleaner | undefined
      let rawDatabaseUrl: string | undefined

      try {
        await assertPostgresPrerequisites(tenantAdmin)
        environment = await createEnvironment(
          processRunner,
          config.baseRootfsImage,
        )

        const closedPort = await findClosedPort(TENANT_DATABASE_HOST)
        resourceId = mintTemporaryDatabaseResourceId()
        const objectName = deriveTemporaryDatabaseObjectName(resourceId)
        const password = generatePreviewSecretValue()
        rawDatabaseUrl = buildTemporaryDatabaseUrl({
          resourceId,
          databaseName: objectName,
          roleName: objectName,
          password,
        }).reveal()
        const expectedDigest = createHash("sha256")
          .update(rawDatabaseUrl, "utf8")
          .digest("hex")

        ownershipStore = new TestOwnershipStore()
        physicalCleaner = new PostgresTemporaryDatabasePhysicalCleaner(
          tenantAdmin,
        )
        const provisioner = new TemporaryDatabaseProvisioner({
          ownershipStore,
          tenantAdmin,
          physicalCleaner,
          createResourceId: () => resourceId!,
          generatePassword: () => password,
        })
        const catalog = new PostgresTemporaryDatabaseTenantCatalog(tenantAdmin)

        otherWorkspace = await environment.sandboxProvisioner.allocate(
          `m11-other-${randomUUID()}`,
        )
        await writeFile(
          path.join(otherWorkspace.rootDir, "other-server.js"),
          otherServerScript,
        )
        await otherWorkspace.normalizeExtractedTree()
        otherHandle = await environment.runtimeStarter.start(
          otherWorkspace,
          otherJobPlan,
        )
        await otherHandle.waitUntilReady(30_000)
        otherLease = requireIngressLease(
          await environment.leaseManager.listOwnedLeases(),
          otherHandle.dialTarget.host,
          false,
        )

        runtimeId = `m11-db-${randomUUID()}`
        requesterSubject = `m11-d-${randomUUID()}`
        const previewId = `fullstack-m11d-${randomUUID()}`
        const store = new InMemoryBackendRuntimeStore()
        const queue = new InMemoryBackendRuntimeQueue()
        controlPlane = new BackendRuntimeControlPlane(
          { resolve: async () => databasePlan },
          store,
          queue,
          { createId: () => runtimeId! },
        )
        const byteStore = new ArchiveByteStore()
        const liveRegistry = new LiveBackendRuntimeRegistry()
        const capturingSandbox: SandboxProvisioner = {
          allocate: async (jobId) => {
            primaryWorkspace =
              await environment!.sandboxProvisioner.allocate(jobId)
            return primaryWorkspace
          },
        }
        const installRunner: CommandRunner = {
          run: async () => undefined,
        }
        const supervisor = new BackendRuntimeSupervisor(
          controlPlane,
          {
            fetch: async () => {
              byteStore.put(repository.commitSha, new Uint8Array())
              return {
                compressedBytes: 10,
                entries: [
                  { path: "package.json", bytes: 10, isSymlink: false },
                ],
              }
            },
          },
          byteStore,
          new ExtractionState(async (_data, options) => {
            const sourceRoot = path.join(options.destinationDir, "backend")
            await mkdir(path.join(sourceRoot, "src"), { recursive: true })
            await writeFile(path.join(sourceRoot, "package-lock.json"), "{}")
            await writeFile(
              path.join(sourceRoot, "src", "server.js"),
              databaseChildScript,
            )
          }),
          capturingSandbox,
          installRunner,
          environment.runtimeStarter,
          liveRegistry,
          {
            temporaryDatabaseProvisioner: provisioner,
            cancellationPollMs: 25,
            monitorPollMs: 25,
            readinessTimeoutMs: 30_000,
          },
        )

        await controlPlane.createForOrchestration(
          { repository, contractVersion: "backend-v1" },
          requesterSubject,
          previewId,
        )
        const leased = await queue.lease("m11-d-worker")
        expect(leased?.job).toMatchObject({
          runtimeId,
          orchestrationKey: previewId,
        } satisfies Partial<QueuedBackendRuntime>)
        supervisorRun = supervisor.run(leased!.job)

        await expect
          .poll(
            async () =>
              (
                await controlPlane!.getForOrchestration(
                  runtimeId!,
                  requesterSubject!,
                )
              ).status,
            { timeout: 90_000, interval: 100 },
          )
          .toBe("running")

        const route = liveRegistry.resolve(runtimeId)
        expect(route).toBeDefined()
        expect(primaryWorkspace).toBeDefined()
        primaryLease = requireIngressLease(
          await environment.leaseManager.listOwnedLeases(),
          route!.host,
          true,
        )

        hostControlPlane = createServer((_request, response) => {
          response.end("test-owned-host-service")
        })
        await listen(hostControlPlane, primaryLease.hostIp)
        const controlAddress = hostControlPlane.address()
        if (!controlAddress || typeof controlAddress === "string") {
          throw new Error("M11 host-control-plane probe did not bind.")
        }

        await writeFile(
          path.join(primaryWorkspace!.rootDir, "probe-targets.json"),
          JSON.stringify({
            sameHostClosedPort: {
              host: TENANT_DATABASE_HOST,
              port: closedPort,
            },
            publicInternet: { host: "1.1.1.1", port: 80 },
            metadata: { host: "169.254.169.254", port: 80 },
            privateRfc1918: { host: "10.0.0.1", port: 80 },
            linkLocal: { host: "169.254.1.1", port: 80 },
            hostControlPlane: {
              host: primaryLease.hostIp,
              port: controlAddress.port,
            },
            otherJob: {
              host: otherLease.peerIp,
              port: otherJobPlan.internalPort,
            },
          }),
        )

        const proofResponse = await getJson(
          route!.host,
          route!.port,
          "/m11-proof",
        )
        const proof = proofResponse.body as ChildProof
        expect(proofResponse.statusCode).toBe(200)
        expect(proof.configured).toBe(true)
        expect(proof.sha256).toBe(expectedDigest)
        expect(proof.attempts.database?.connected).toBe(true)
        for (const name of [
          "sameHostClosedPort",
          "publicInternet",
          "metadata",
          "privateRfc1918",
          "linkLocal",
          "hostControlPlane",
          "otherJob",
        ]) {
          expect(proof.attempts[name]?.connected, name).toBe(false)
        }
        expect(proof.routes).not.toMatch(/^\S+\s+00000000\s+/mu)

        const routes = await runChecked(environment.processRunner, "ip", [
          "-n",
          primaryLease.namespace,
          "-j",
          "-4",
          "route",
          "show",
        ])
        const parsedRoutes = JSON.parse(routes.stdout) as Array<{
          dst?: string
          gateway?: string
          dev?: string
        }>
        const databaseRoutes = parsedRoutes.filter(
          (candidate) =>
            candidate.dst === TENANT_DATABASE_HOST ||
            candidate.dst === `${TENANT_DATABASE_HOST}/32`,
        )
        expect(databaseRoutes).toEqual([
          expect.objectContaining({
            gateway: primaryLease.hostIp,
            dev: primaryLease.peerVeth,
          }),
        ])
        expect(
          parsedRoutes.some((candidate) => candidate.dst === "default"),
        ).toBe(false)

        const inputRules = await runChecked(
          environment.processRunner,
          "iptables",
          ["-w", "5", "-S", primaryLease.inputChain],
        )
        const ruleLines = inputRules.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
        const databaseAcceptRules = ruleLines.filter(
          (line) =>
            line.includes(`-d ${TENANT_DATABASE_HOST}/32`) &&
            line.includes("-p tcp") &&
            line.includes(`--dport ${String(TENANT_DATABASE_PORT)}`) &&
            line.endsWith("-j ACCEPT"),
        )
        expect(databaseAcceptRules).toHaveLength(1)
        expect(
          ruleLines.filter((line) => line.endsWith("-j ACCEPT")),
        ).toHaveLength(2)

        expect(
          await inspectNetworkResources(
            environment.processRunner,
            primaryLease,
          ),
        ).toEqual({
          namespace: true,
          hostVeth: true,
          ipv4: true,
          nat: false,
          ipv6: true,
        })

        const credentialRootType = await runChecked(
          environment.processRunner,
          "findmnt",
          ["-n", "-o", "FSTYPE", "--target", environment.credentialRoot],
        )
        expect(credentialRootType.stdout.trim()).toBe("tmpfs")
        const runtimeCredentialDir = path.join(
          environment.credentialRoot,
          runtimeId,
        )
        const credentialDirectoryStats = await lstat(runtimeCredentialDir)
        const credentialFileStats = await lstat(
          path.join(runtimeCredentialDir, DATABASE_CREDENTIAL_FILE_NAME),
        )
        expect(credentialDirectoryStats.isDirectory()).toBe(true)
        expect(credentialDirectoryStats.isSymbolicLink()).toBe(false)
        expect(credentialDirectoryStats.mode & 0o777).toBe(0o700)
        expect(credentialDirectoryStats.uid).toBe(SANDBOX_UID)
        expect(credentialDirectoryStats.gid).toBe(SANDBOX_GID)
        expect(credentialFileStats.isFile()).toBe(true)
        expect(credentialFileStats.isSymbolicLink()).toBe(false)
        expect(credentialFileStats.mode & 0o777).toBe(0o600)
        expect(credentialFileStats.uid).toBe(SANDBOX_UID)
        expect(credentialFileStats.gid).toBe(SANDBOX_GID)

        const serializedConfig = await readFile(
          path.join(primaryWorkspace!.bundleDir, "config.json"),
          "utf8",
        )
        const ociConfig = JSON.parse(serializedConfig) as {
          process: { env: string[]; args: string[] }
          mounts: Array<{
            destination: string
            type: string
            source: string
            options: string[]
          }>
        }
        expect(serializedConfig.includes(rawDatabaseUrl)).toBe(false)
        expect(ociConfig.process.env).toEqual([
          "PORT=3000",
          "HOST=0.0.0.0",
          "NODE_ENV=production",
        ])
        expect(ociConfig.process.args.includes(rawDatabaseUrl)).toBe(false)
        expect(ociConfig.process.args).toContain(SANDBOX_SECRET_BOOTSTRAP)
        expect(
          ociConfig.mounts.filter(
            (mount) => mount.destination === SANDBOX_DATABASE_CREDENTIAL_FILE,
          ),
        ).toEqual([
          {
            destination: SANDBOX_DATABASE_CREDENTIAL_FILE,
            type: "bind",
            source: path.join(
              environment.credentialRoot,
              runtimeId,
              DATABASE_CREDENTIAL_FILE_NAME,
            ),
            options: ["bind", "ro", "nosuid", "nodev", "noexec"],
          },
        ])

        const activeScan = await scanRunscStateForRawValue(
          environment.runscRootDir,
          rawDatabaseUrl,
        )
        expect(activeScan.complete).toBe(true)
        expect(activeScan.found).toBe(false)
        expect(await catalog.inspectResource(resourceId)).toEqual({
          database: true,
          role: true,
        })
        expect(await ownershipStore.getByResourceId(resourceId)).toMatchObject({
          previewId,
          backendRuntimeId: runtimeId,
          status: "provisioned",
        })

        await close(hostControlPlane)
        hostControlPlane = undefined
        await controlPlane.cancelForOrchestration(runtimeId, requesterSubject)
        await supervisorRun
        supervisorRun = undefined

        expect(
          await controlPlane.getForOrchestration(runtimeId, requesterSubject),
        ).toMatchObject({ status: "stopped", errorCode: null })
        expect(liveRegistry.resolve(runtimeId)).toBeUndefined()
        expect(await ownershipStore.getByResourceId(resourceId)).toMatchObject({
          status: "revoked",
        })
        expect(await catalog.inspectResource(resourceId)).toEqual({
          database: false,
          role: false,
        })
        await expect(stat(runtimeCredentialDir)).rejects.toThrow()

        const postStopScan = await scanRunscStateForRawValue(
          environment.runscRootDir,
          rawDatabaseUrl,
        )
        expect(postStopScan.complete).toBe(true)
        expect(postStopScan.found).toBe(false)

        await otherHandle.stop()
        await otherHandle.waitForExit()
        otherHandle = undefined
        await otherWorkspace.destroy()
        otherWorkspace = undefined

        expect(await environment.diskManager.listOwnedAllocations()).toEqual([])
        expect(await environment.leaseManager.listOwnedLeases()).toEqual([])
        expect(await listOwnedTestContainers(environment)).toEqual([])
        expect(
          await listOwnedDatabaseCredentialRuntimeIds(
            environment.credentialRoot,
            100,
          ),
        ).toEqual([])
        expect(await readdir(environment.credentialRoot)).toEqual([])
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
        expect(
          await inspectNetworkResources(environment.processRunner, otherLease),
        ).toEqual({
          namespace: false,
          hostVeth: false,
          ipv4: false,
          nat: false,
          ipv6: false,
        })
      } catch (error) {
        scenarioError = error
      } finally {
        if (hostControlPlane) {
          await close(hostControlPlane).catch((error) =>
            cleanupErrors.push(error),
          )
        }
        if (supervisorRun && controlPlane && runtimeId && requesterSubject) {
          await controlPlane
            .cancelForOrchestration(runtimeId, requesterSubject)
            .catch((error) => cleanupErrors.push(error))
          await supervisorRun.catch((error) => cleanupErrors.push(error))
        }
        if (otherHandle) {
          await otherHandle.stop().catch((error) => cleanupErrors.push(error))
        }
        if (otherWorkspace) {
          await otherWorkspace
            .destroy()
            .catch((error) => cleanupErrors.push(error))
        }
        if (primaryWorkspace) {
          await primaryWorkspace
            .destroy()
            .catch((error) => cleanupErrors.push(error))
        }

        if (resourceId && ownershipStore && physicalCleaner) {
          const record = await ownershipStore
            .getByResourceId(resourceId)
            .catch((error) => {
              cleanupErrors.push(error)
              return null
            })
          if (record && record.status !== "revoked") {
            const catalog = new PostgresTemporaryDatabaseTenantCatalog(
              tenantAdmin,
            )
            const presence = await catalog
              .inspectResource(resourceId)
              .catch((error) => {
                cleanupErrors.push(error)
                return null
              })
            if (presence?.database && presence.role) {
              await physicalCleaner
                .cleanupFull(resourceId)
                .catch((error) => cleanupErrors.push(error))
            } else if (presence && !presence.database && presence.role) {
              await physicalCleaner
                .cleanupRoleOnly(resourceId)
                .catch((error) => cleanupErrors.push(error))
            } else if (presence?.database && !presence.role) {
              cleanupErrors.push(
                new Error(
                  `M11 test resource ${resourceId} has a database without its owned role; exact cleanup was refused.`,
                ),
              )
            }
          }
        }

        if (environment) {
          const credentialIds = await listOwnedDatabaseCredentialRuntimeIds(
            environment.credentialRoot,
            100,
          ).catch((error): null => {
            cleanupErrors.push(error)
            return null
          })
          if (credentialIds === null) {
            cleanupErrors.push(
              new Error(
                `M11 test credential root was preserved because exact inspection failed: ${environment.credentialRoot}`,
              ),
            )
          } else if (credentialIds.length > 0) {
            cleanupErrors.push(
              new Error(
                `M11 test credential root was preserved because ${String(credentialIds.length)} owned runtime entries remain: ${environment.credentialRoot}`,
              ),
            )
          } else {
            const remainingEntries = await readdir(
              environment.credentialRoot,
            ).catch((error): null => {
              cleanupErrors.push(error)
              return null
            })
            if (remainingEntries === null || remainingEntries.length > 0) {
              cleanupErrors.push(
                new Error(
                  `M11 test credential root was preserved because it is not provably empty: ${environment.credentialRoot}`,
                ),
              )
            } else {
              await rmdir(environment.credentialRoot).catch((error) =>
                cleanupErrors.push(error),
              )
            }
          }

          const clean = await environmentIsClean(environment).catch((error) => {
            cleanupErrors.push(error)
            return false
          })
          if (clean) {
            const outcome = await removeDedicatedTestRootIfReconciled(
              environment.rootDir,
              environment.runscRootDir,
            ).catch((error) => {
              cleanupErrors.push(error)
              return { removed: false, reason: "reconciliation failed" }
            })
            if (!outcome.removed) {
              cleanupErrors.push(
                new Error(
                  `M11 test root was preserved because exact reconciliation was incomplete (${outcome.reason}).`,
                ),
              )
            }
          } else {
            cleanupErrors.push(
              new Error(
                `M11 test root was preserved because owned runtime residue remains: ${environment.rootDir}`,
              ),
            )
          }
        }
        await tenantAdmin.close().catch((error) => cleanupErrors.push(error))
      }

      if (scenarioError && cleanupErrors.length > 0) {
        throw new AggregateError(
          [scenarioError, ...cleanupErrors],
          "M11 real-gVisor database verification failed and exact-resource cleanup was incomplete.",
          { cause: scenarioError },
        )
      }
      if (scenarioError) throw scenarioError
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          "M11 real-gVisor database verification cleanup was incomplete.",
        )
      }
    }, 300_000)
  },
)

function realDatabaseSuiteEnabled(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    environment[REAL_GVISOR_GATE] === "1" &&
    environment[M11_DATABASE_GATE] === "1"
  )
}

function readRequiredConfiguration(environment: NodeJS.ProcessEnv): {
  postgresUrl: string
  baseRootfsImage: string
} {
  const postgresUrl = environment[M11_POSTGRES_URL]
  if (!postgresUrl || postgresUrl.length > 4_096) {
    throw new Error(
      `${M11_POSTGRES_URL} is required for the explicitly enabled M11 suite.`,
    )
  }
  let parsed: URL
  try {
    parsed = new URL(postgresUrl)
  } catch {
    throw new Error(`${M11_POSTGRES_URL} is invalid.`)
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.hostname !== TENANT_DATABASE_HOST ||
    parsed.port !== String(TENANT_DATABASE_PORT) ||
    parsed.username === "" ||
    parsed.password === "" ||
    parsed.pathname === "" ||
    parsed.pathname === "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      `${M11_POSTGRES_URL} must name the prepared PostgreSQL 18 endpoint at the locked host and port with an explicit database and provisioning identity.`,
    )
  }

  const configuredRootfs = environment[BASE_ROOTFS_ENV]?.trim()
  if (!configuredRootfs || !path.isAbsolute(configuredRootfs)) {
    throw new Error(
      `${BASE_ROOTFS_ENV} must explicitly name the test-specific rebuilt base rootfs.`,
    )
  }
  const baseRootfsImage = path.resolve(configuredRootfs)
  if (baseRootfsImage === PRODUCTION_BASE_ROOTFS) {
    throw new Error(
      `${BASE_ROOTFS_ENV} must not point at the production base rootfs for M11 verification.`,
    )
  }
  return { postgresUrl, baseRootfsImage }
}

async function assertHostPrerequisites(
  runner: NodeProcessRunner,
  baseRootfsImage: string,
): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error("The explicitly enabled M11 suite requires Linux.")
  }
  if (process.getuid?.() !== 0) {
    throw new Error(
      "The explicitly enabled M11 suite requires root privileges.",
    )
  }
  for (const [command, args] of [
    ["runsc", ["--version"]],
    ["ip", ["-Version"]],
    ["iptables", ["--version"]],
    ["ip6tables", ["--version"]],
    ["findmnt", ["--version"]],
  ] as const) {
    await runChecked(runner, command, [...args]).catch(() => {
      throw new Error(
        `The explicitly enabled M11 suite is missing required host command ${command}.`,
      )
    })
  }
  await assertBaseRootfsShape(baseRootfsImage)
}

async function assertPostgresPrerequisites(
  tenantAdmin: PostgresTenantAdmin,
): Promise<void> {
  try {
    await tenantAdmin.withSession(async (session) => {
      const version = await session.query<{ version_num: string }>(
        "SELECT current_setting('server_version_num') AS version_num",
      )
      const versionNumber = Number(version.rows[0]?.version_num)
      if (versionNumber < 180_000 || versionNumber >= 190_000) {
        throw new Error("PostgreSQL major version 18 is required.")
      }
      const provisioningRole = await readProvisioningSessionPolicy(session)
      const attributes = await session.query<{
        rolcanlogin: boolean
        rolsuper: boolean
        rolcreatedb: boolean
        rolcreaterole: boolean
        rolreplication: boolean
        rolbypassrls: boolean
      }>(
        `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
                rolreplication, rolbypassrls
         FROM pg_roles WHERE rolname = $1`,
        [provisioningRole],
      )
      const role = attributes.rows[0]
      if (
        !role?.rolcanlogin ||
        role.rolsuper ||
        !role.rolcreatedb ||
        !role.rolcreaterole ||
        role.rolreplication ||
        role.rolbypassrls
      ) {
        throw new Error(
          "The supplied PostgreSQL identity does not satisfy the locked provisioning-role policy.",
        )
      }
    })
  } catch {
    throw new Error(
      "The explicitly enabled M11 suite requires a reachable PostgreSQL 18 endpoint and the locked non-superuser provisioning-role policy.",
    )
  }
}

async function assertBaseRootfsShape(baseRootfsImage: string): Promise<void> {
  const rootStats = await lstat(baseRootfsImage).catch(() => null)
  const canonical = await realpath(baseRootfsImage).catch(() => null)
  if (
    !rootStats?.isDirectory() ||
    rootStats.isSymbolicLink() ||
    canonical !== baseRootfsImage
  ) {
    throw new Error(
      "The M11 test base rootfs must be an ordinary, symlink-free directory.",
    )
  }

  for (const relative of ["run/secrets/env", "run/secrets/database-url"]) {
    const stats = await lstatSymlinkFree(baseRootfsImage, relative)
    if (
      !stats.isFile() ||
      stats.size !== 0 ||
      stats.uid !== 0 ||
      stats.gid !== 0 ||
      (stats.mode & 0o777) !== 0o644
    ) {
      throw new Error(
        "The M11 test base rootfs credential placeholders are invalid.",
      )
    }
  }
  const bootstrap = await lstatSymlinkFree(
    baseRootfsImage,
    SANDBOX_SECRET_BOOTSTRAP.slice(1),
  )
  if (!bootstrap.isFile() || bootstrap.uid !== 0 || bootstrap.gid !== 0) {
    throw new Error("The M11 test base rootfs trusted bootstrap is invalid.")
  }
}

async function lstatSymlinkFree(root: string, relative: string) {
  let candidate = root
  const segments = relative.split("/").filter(Boolean)
  for (const [index, segment] of segments.entries()) {
    candidate = path.join(candidate, segment)
    const stats = await lstat(candidate).catch(() => null)
    if (!stats || stats.isSymbolicLink()) {
      throw new Error("The M11 test base rootfs path is missing or unsafe.")
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new Error("The M11 test base rootfs path is not traversable.")
    }
    if (index === segments.length - 1) return stats
  }
  throw new Error("The M11 test base rootfs path is invalid.")
}

async function createEnvironment(
  processRunner: NodeProcessRunner,
  baseRootfsImage: string,
): Promise<RealDatabaseEnvironment> {
  const rootDir = await createRealGvisorTestDirectory(
    "peephole-real-m11-database-",
  )
  let credentialRoot: string | undefined
  try {
    const bundlesRootDir = path.join(rootDir, "bundles")
    const runscRootDir = path.join(rootDir, "runsc")
    const leaseDir = path.join(rootDir, "network-leases")
    await Promise.all([
      mkdir(bundlesRootDir, { recursive: true }),
      mkdir(runscRootDir, { recursive: true }),
      mkdir(leaseDir, { recursive: true }),
    ])
    credentialRoot = await createDatabaseCredentialTestRoot()
    const leaseManager = new NetworkLeaseManager({ leaseDir })
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
    const databaseCredentialFilesystem = new TmpfsDatabaseCredentialFilesystem({
      rootDir: credentialRoot,
      processRunner,
      forbiddenRoots: [DEFAULT_DATABASE_CREDENTIAL_ROOT, bundlesRootDir],
    })
    const runtimeStarter = new GVisorBackendRuntimeProcess({
      runscRootDir,
      processRunner,
      maxRuntimeMs: 240_000,
      databaseCredentialFilesystem,
    })
    return {
      rootDir,
      bundlesRootDir,
      runscRootDir,
      credentialRoot,
      processRunner,
      leaseManager,
      networkProvisioner,
      diskManager,
      sandboxProvisioner,
      runtimeStarter,
    }
  } catch (error) {
    if (credentialRoot) {
      await rm(credentialRoot, { recursive: true, force: true }).catch(
        () => undefined,
      )
    }
    await rm(rootDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function createDatabaseCredentialTestRoot(): Promise<string> {
  await mkdir(DATABASE_TEST_PARENT_DIR, { recursive: true, mode: 0o700 })
  return mkdtemp(
    path.join(DATABASE_TEST_PARENT_DIR, "real-gvisor-db-credentials-"),
  )
}

async function findClosedPort(host: string): Promise<number> {
  for (const port of [15433, 25433, 35433, 45433, 55433]) {
    const result = await probeHostPort(host, port, 300)
    if (!result.connected && result.error === "ECONNREFUSED") return port
  }
  throw new Error(
    "No bounded, listener-free same-host port was available for the M11 negative probe.",
  )
}

function probeHostPort(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const finish = (result: ProbeResult) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs, () =>
      finish({ connected: false, error: "TIMEOUT" }),
    )
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish({ connected: false, error: error.code ?? "ERROR" }),
    )
    socket.once("connect", () => finish({ connected: true, error: null }))
  })
}

function requireIngressLease(
  leases: readonly NetworkLease[],
  peerIp: string,
  temporaryDatabaseAccess: boolean,
): NetworkLease {
  const lease = leases.find(
    (candidate) =>
      candidate.policy === "ingress-only" &&
      candidate.peerIp === peerIp &&
      candidate.temporaryDatabaseAccess === temporaryDatabaseAccess,
  )
  if (!lease) {
    throw new Error("Expected an owned ingress-only network lease.")
  }
  return lease
}

async function getJson(
  host: string,
  port: number,
  requestPath: string,
): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpGet(
      { host, port, path: requestPath, timeout: 15_000 },
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
      `${command} failed (exit ${String(result.exitCode)}, timedOut=${String(result.timedOut)}).`,
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

async function listOwnedTestContainers(
  environment: RealDatabaseEnvironment,
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
  environment: RealDatabaseEnvironment,
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

class TestOwnershipStore implements TemporaryDatabaseOwnershipStore {
  private record: TemporaryDatabaseRecord | null = null

  async createProvisioning(
    input: CreateTemporaryDatabaseOwnership,
  ): Promise<TemporaryDatabaseRecord> {
    if (this.record) throw new Error("Test ownership already exists.")
    this.record = {
      resourceId: input.resourceId,
      previewId: input.previewId,
      backendRuntimeId: input.backendRuntimeId,
      status: "provisioning",
      createdAt: input.now.toISOString(),
      updatedAt: input.now.toISOString(),
    }
    return this.record
  }

  async getByResourceId(
    resourceId: TemporaryDatabaseResourceId,
  ): Promise<TemporaryDatabaseRecord | null> {
    return this.record?.resourceId === resourceId ? this.record : null
  }

  async getByPreviewId(
    previewId: string,
  ): Promise<TemporaryDatabaseRecord | null> {
    return this.record?.previewId === previewId ? this.record : null
  }

  async listAll(): Promise<TemporaryDatabaseRecord[]> {
    return this.record ? [this.record] : []
  }

  markProvisioned(resourceId: TemporaryDatabaseResourceId, now: Date) {
    return this.transition(resourceId, "provisioning", "provisioned", now)
  }

  markRevoking(resourceId: TemporaryDatabaseResourceId, now: Date) {
    return this.transition(resourceId, "provisioned", "revoking", now)
  }

  markRevoked(resourceId: TemporaryDatabaseResourceId, now: Date) {
    return this.transition(resourceId, "revoking", "revoked", now)
  }

  markRevokeFailed(resourceId: TemporaryDatabaseResourceId, now: Date) {
    return this.transition(resourceId, "revoking", "revoke_failed", now)
  }

  beginReconciliation(
    resourceId: TemporaryDatabaseResourceId,
    expectedStatus: TemporaryDatabaseReconciliationSourceStatus,
    now: Date,
  ) {
    return this.transition(resourceId, expectedStatus, "revoking", now)
  }

  private async transition(
    resourceId: TemporaryDatabaseResourceId,
    from: TemporaryDatabaseStatus,
    to: TemporaryDatabaseStatus,
    now: Date,
  ): Promise<TemporaryDatabaseRecord> {
    if (!this.record || this.record.resourceId !== resourceId) {
      throw new Error("Test ownership does not exist.")
    }
    if (this.record.status !== from) {
      throw new Error("Test ownership transition was rejected.")
    }
    this.record = { ...this.record, status: to, updatedAt: now.toISOString() }
    return this.record
  }
}

const otherServerScript = `
const http = require("node:http")
const port = Number(process.env.PORT)
http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" })
  response.end(JSON.stringify({ status: "ok" }))
}).listen(port, "0.0.0.0")
`

const databaseChildScript = `
const crypto = require("node:crypto")
const fs = require("node:fs")
const http = require("node:http")
const net = require("node:net")

const port = Number(process.env.PORT)
const databaseUrl = process.env.DATABASE_URL

function connect(target) {
  return new Promise((resolve) => {
    const socket = net.createConnection(target)
    const finish = (connected, error = null) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve({ connected, error })
    }
    socket.setTimeout(1500, () => finish(false, "TIMEOUT"))
    socket.once("error", (error) => finish(false, error.code || "ERROR"))
    socket.once("connect", () => finish(true))
  })
}

async function buildProof() {
  if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
    return { configured: false, sha256: null, routes: "", attempts: {} }
  }
  const parsed = new URL(databaseUrl)
  const targets = JSON.parse(
    fs.readFileSync("/workspace/probe-targets.json", "utf8"),
  )
  const attempts = {
    database: await connect({
      host: parsed.hostname,
      port: Number(parsed.port),
    }),
  }
  await Promise.all(
    Object.entries(targets).map(async ([name, target]) => {
      attempts[name] = await connect(target)
    }),
  )
  return {
    configured: true,
    sha256: crypto.createHash("sha256").update(databaseUrl, "utf8").digest("hex"),
    routes: fs.readFileSync("/proc/net/route", "utf8"),
    attempts,
  }
}

http.createServer(async (request, response) => {
  response.setHeader("content-type", "application/json")
  if (request.url === "/health") {
    response.end(JSON.stringify({ status: "ok" }))
    return
  }
  if (request.url === "/m11-proof") {
    try {
      response.end(JSON.stringify(await buildProof()))
    } catch {
      response.writeHead(500)
      response.end(JSON.stringify({ configured: Boolean(databaseUrl) }))
    }
    return
  }
  response.writeHead(404)
  response.end(JSON.stringify({ status: "not-found" }))
}).listen(port, "0.0.0.0")
`
