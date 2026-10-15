import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { get } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "vitest"
import { Pool } from "pg"

import { createBuildCacheKey } from "../core/preview/buildPlan"
import { BackendRuntimeControlPlane } from "../services/backend-runtime-api/controlPlane"
import type { BackendRuntimeDiagnosticEvent } from "../services/backend-runtime-api/diagnostics"
import {
  InMemoryBackendRuntimeQueue,
  InMemoryBackendRuntimeStore,
} from "../services/backend-runtime-api/inMemoryAdapters"
import { LiveBackendRuntimeRegistry } from "../services/backend-runtime-worker/liveRuntimeRegistry"
import { InMemoryBackendRuntimeSecretBroker } from "../services/backend-runtime-worker/secretBroker"
import { FullStackPreviewControlPlane } from "../services/fullstack-preview-api/controlPlane"
import { FullStackPreviewSupervisor } from "../services/fullstack-preview-worker/fullStackPreviewSupervisor"
import { FullStackRoutingActivator } from "../services/fullstack-routing/fullStackRoutingActivator"
import { PreviewControlPlane } from "../services/preview-api/controlPlane"
import {
  InMemoryPreviewArtifactCache,
  InMemoryPreviewJobStore,
  InMemoryPreviewQueue,
} from "../services/preview-api/inMemoryAdapters"
import { composeProductionBackendRuntime } from "../services/preview-worker/gvisor/composeProductionBackendRuntime"
import {
  TmpfsGeneratedSecretFilesystem,
  SANDBOX_GENERATED_SECRET_FILE,
} from "../services/preview-worker/gvisor/generatedSecretFilesystem"
import {
  TmpfsDatabaseCredentialFilesystem,
  SANDBOX_DATABASE_CREDENTIAL_FILE,
} from "../services/preview-worker/gvisor/databaseCredentialFilesystem"
import {
  TmpfsUserEnvironmentFilesystem,
  SANDBOX_USER_ENVIRONMENT_FILE,
} from "../services/preview-worker/gvisor/userEnvironmentFilesystem"
import { VethNatNetworkProvisioner } from "../services/preview-worker/gvisor/networkNamespace"
import { NodeProcessRunner } from "../services/preview-worker/gvisor/nodeProcessRunner"
import type { ProcessRunner } from "../services/preview-worker/gvisor/processRunner"
import { LoopbackSandboxDiskManager } from "../services/preview-worker/gvisor/sandboxDisk"
import { NetworkLeaseManager } from "../services/preview-worker/gvisor/subnetAllocator"
import {
  ensureDatabaseCredentialCapability,
  ensureGeneratedSecretInjectionCapability,
  ensureUserEnvironmentCapability,
} from "../services/production/preflight"
import { PostgresTenantAdmin } from "../services/temporary-database/postgresTenantAdmin"
import { PostgresTemporaryDatabaseTenantCatalog } from "../services/temporary-database/postgresTenantCatalog"
import { TemporaryDatabaseProvisioner } from "../services/temporary-database/temporaryDatabaseProvisioner"
import { readProvisioningSessionPolicy } from "../services/temporary-database/tenantSessionPolicy"
import { InMemoryUserEnvironmentBroker } from "../services/user-environment/userEnvironmentBroker"
import type { BackendRuntimePlan } from "../types/backendRuntime"
import { TestOwnershipStore } from "./support/temporaryDatabaseTestOwnership"
import {
  FakeFullStackPreviewQueue,
  FakeFullStackPreviewStore,
  validBackendPlan,
  validFrontendPlan,
} from "./support/fakeFullStackPreview"
import {
  createOwnedRunSet,
  deriveM12ComponentPaths,
  protectedResourceRoots,
  removeOwnedRunDirectory,
  verifyOwnedRunDirectory,
  type M12ComponentPaths,
  type M12RunDirectories,
} from "./support/m12RealGvisorHarness"
import { reconcileDedicatedRunscStateForCleanup } from "./support/realRunscStateInspection"
import {
  attemptCombinedCleanup,
  CombinedHarnessError,
  combinedSuiteEnabled,
  preflightCombinedHost,
  requireCombined,
  safeDiagnostic,
  takeCombinedParent,
  validatePostgresLogging,
  type CombinedCode,
  type StepStatus,
} from "./support/m12CombinedSafety"

const repository = {
  repositoryId: 1371618449,
  owner: "The-peephole",
  name: "peephole-fixture-fullstack",
  commitSha: "90afaa0c3f650744300afc5d8fed00fd4a0ef5c8",
}
const frontendPlan = { ...validFrontendPlan, repository }
const backendPlan: BackendRuntimePlan = {
  ...validBackendPlan,
  repository,
  generatedSecretNames: ["SESSION_SECRET"],
  databaseRequirement: { name: "DATABASE_URL" },
  userEnvironmentNames: ["APP_GREETING"],
}
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
)

/** Explicit opt-in only. Never discover/start a host, DB or AWS resource.
 * Frontend artifact metadata is seeded; the backend DB/gVisor boundaries
 * below are real. This is not Chrome/frontend-origin/OAuth E2E. */
describe.skipIf(!combinedSuiteEnabled(process.env))(
  "M10/M11/M12 combined runtime (dedicated Linux + PG18 + runsc)",
  () => {
    it("runs the pinned backend through Fullstack orchestration, query and Stop/reclamation", async () => {
      const stages = {
        preflight: "NOT_RUN",
        setup: "NOT_RUN",
        fullstack: "NOT_RUN",
        readiness: "NOT_RUN",
        materials: "NOT_RUN",
        config: "NOT_RUN",
        query: "NOT_RUN",
        secret: "NOT_RUN",
        stop: "NOT_RUN",
        reclamation: "NOT_RUN",
      } satisfies Record<string, StepStatus> as Record<
        | "preflight"
        | "setup"
        | "fullstack"
        | "readiness"
        | "materials"
        | "config"
        | "query"
        | "secret"
        | "stop"
        | "reclamation",
        StepStatus
      >
      let failure: CombinedCode | null = null
      let diagnostic: BackendRuntimeDiagnosticEvent | null = null
      let runs: M12RunDirectories | undefined
      let allocationAttempted = false
      let paths: M12ComponentPaths | undefined
      let tenant: PostgresTenantAdmin | undefined
      let postgresPoolError = false
      let catalog: PostgresTemporaryDatabaseTenantCatalog | undefined
      let ownership: TestOwnershipStore | undefined
      let disk: LoopbackSandboxDiskManager | undefined
      let leases: NetworkLeaseManager | undefined
      let fullStack: FullStackPreviewControlPlane | undefined
      let backend: BackendRuntimeControlPlane | undefined
      let fullStackRun: Promise<boolean> | undefined
      let backendRun: Promise<boolean> | undefined
      const parentId = `fullstack-${randomUUID()}`
      const runtimeId = randomUUID()
      const requester = { subject: `combined-${randomUUID()}`, ip: "127.0.0.1" }
      const backendAbort = new AbortController()
      const parentAbort = new AbortController()
      const oldTmpdir = process.env.TMPDIR
      // Real runner, with sandbox output suppressed at the adapter boundary.
      // Other host commands need their bounded stdout for authoritative checks.
      const realRunner = new NodeProcessRunner()
      const runner: ProcessRunner = {
        run: async (command, args, options) => {
          const result = await realRunner.run(command, args, options)
          return path.basename(command) === "runsc" && args.includes("run")
            ? { ...result, stdout: "", stderr: "" }
            : result
        },
      }
      async function step<T>(
        name: keyof typeof stages,
        code: CombinedCode,
        action: () => Promise<T>,
      ): Promise<T> {
        try {
          const value = await action()
          stages[name] = "PASS"
          return value
        } catch (error) {
          stages[name] = "FAIL"
          throw error instanceof CombinedHarnessError
            ? error
            : new CombinedHarnessError(code)
        }
      }
      try {
        const host = await step("preflight", "PREFLIGHT_FAILED", async () => {
          const value = await preflightCombinedHost(
            process.env,
            await readFile(
              path.join(projectRoot, "scripts/gvisor/secret-bootstrap.mjs"),
            ),
          )
          for (const [command, args] of [
            ["runsc", ["--version"]],
            ["ip", ["-Version"]],
            ["iptables", ["--version"]],
            ["ip6tables", ["--version"]],
            ["findmnt", ["--version"]],
            ["losetup", ["--version"]],
          ] as const) {
            const result = await runner.run(command, [...args], {
              timeoutMs: 10_000,
            })
            requireCombined(
              result.exitCode === 0 && !result.timedOut,
              "PREFLIGHT_FAILED",
            )
          }
          await requireNoPeepholeNetworks(runner, "HOST_OWNERSHIP_REJECTED")
          const pool = new Pool(value.postgres)
          pool.on("error", () => {
            postgresPoolError = true
          })
          tenant = new PostgresTenantAdmin(value.postgres, pool)
          await tenant.withSession(async (session) => {
            requireCombined(
              (await readProvisioningSessionPolicy(session)) ===
                "m12_combined_provisioner",
              "POSTGRES_POLICY_REJECTED",
            )
            const settings = await session.query<{
              version: number
              local: boolean
              port: string
              listener: string
              encryption: string
            }>(
              "SELECT current_setting('server_version_num')::int AS version, inet_server_addr() IS NULL AS local, current_setting('port') AS port, current_setting('listen_addresses') AS listener, current_setting('password_encryption') AS encryption",
            )
            const row = settings.rows[0]
            requireCombined(
              row &&
                row.version >= 180000 &&
                row.version < 190000 &&
                row.local &&
                row.port === "5433" &&
                row.listener === "192.168.253.1" &&
                row.encryption === "scram-sha-256",
              "POSTGRES_POLICY_REJECTED",
            )
            const roles = await session.query<{ safe: boolean }>(
              "SELECT rolcanlogin AND rolcreatedb AND rolcreaterole AND NOT (rolsuper OR rolreplication OR rolbypassrls) AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = pg_roles.oid) AS safe FROM pg_roles WHERE rolname = current_user",
            )
            requireCombined(
              roles.rows[0]?.safe === true,
              "POSTGRES_POLICY_REJECTED",
            )
            const logging = await session.query<{
              name: string
              setting: string
            }>(
              "SELECT name, setting FROM pg_settings WHERE name IN ('log_statement', 'log_min_error_statement', 'log_min_messages', 'log_duration', 'log_min_duration_statement', 'log_min_duration_sample', 'log_transaction_sample_rate', 'log_parameter_max_length', 'log_parameter_max_length_on_error')",
            )
            validatePostgresLogging(
              Object.fromEntries(
                logging.rows.map((row) => [row.name, row.setting]),
              ),
            )
          })
          catalog = new PostgresTemporaryDatabaseTenantCatalog(tenant)
          const before = await catalog.snapshot()
          requireCombined(
            before.roles.length === 0 && before.databases.length === 0,
            "DATABASE_OWNERSHIP_REJECTED",
          )
          return value
        })
        const registry = new LiveBackendRuntimeRegistry()
        const backendQueue = new InMemoryBackendRuntimeQueue()
        const backendStore = new InMemoryBackendRuntimeStore()
        const broker = new InMemoryUserEnvironmentBroker()
        const fullStore = new FakeFullStackPreviewStore()
        const fullQueue = new FakeFullStackPreviewQueue()
        const quota = { consume: async () => ({ allowed: true as const }) }
        await step("setup", "SETUP_FAILED", async () => {
          allocationAttempted = true
          runs = await createOwnedRunSet(host.config)
          paths = deriveM12ComponentPaths(
            host.config,
            runs,
            protectedResourceRoots(process.env),
          )
          for (const directory of [
            paths.bundlesRootDir,
            paths.leaseDir,
            paths.runscRootDir,
            `${runs.workspace.path}/archive-tmp`,
          ])
            await mkdir(directory, { recursive: true, mode: 0o700 })
          // GitHubCommitArchiveFetcher stages its tar under os.tmpdir(). Keep
          // that existing implementation inside this run's owned host tree.
          process.env.TMPDIR = `${runs.workspace.path}/archive-tmp`
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
          leases = new NetworkLeaseManager({ leaseDir: paths.leaseDir })
          disk = new LoopbackSandboxDiskManager({
            bundlesRootDir: paths.bundlesRootDir,
            processRunner: runner,
          })
          ownership = new TestOwnershipStore(async (record) => {
            requireCombined(
              (await verifyOwnedRunDirectory(runs!.workspace)).ok,
              "DATABASE_OWNERSHIP_REJECTED",
            )
            // Secret-free receipt precedes SQL provisioning and survives an
            // incomplete cleanup. It is not a replacement for PostgreSQL FKs.
            await writeFile(
              `${runs!.workspace.path}/ownership-${record.status}.json`,
              JSON.stringify({
                resourceId: record.resourceId,
                previewId: record.previewId,
                backendRuntimeId: record.backendRuntimeId,
                status: record.status,
              }),
              { flag: "wx", mode: 0o600 },
            )
          })
          backend = new BackendRuntimeControlPlane(
            { resolve: async () => backendPlan },
            backendStore,
            backendQueue,
            {
              createId: () => runtimeId,
              runtimeTtlMs: 300_000,
              onDiagnostics: (event) => {
                diagnostic = safeDiagnostic(event)
              },
            },
          )
          fullStack = new FullStackPreviewControlPlane(
            { resolve: async () => frontendPlan },
            { resolve: async () => backendPlan },
            fullStore,
            fullQueue,
            quota,
            { createId: () => parentId, userEnvironmentBroker: broker },
          )
        })
        const configuredPaths = paths!
        const provisioner = new TemporaryDatabaseProvisioner({
          tenantAdmin: tenant!,
          ownershipStore: ownership!,
        })
        const supervisor = composeProductionBackendRuntime(backend!, {
          baseRootfsImage: configuredPaths.baseRootfsImage,
          bundlesRootDir: configuredPaths.bundlesRootDir,
          runscRootDir: configuredPaths.runscRootDir,
          processRunner: runner,
          networkProvisioner: new VethNatNetworkProvisioner({
            processRunner: runner,
            leaseManager: leases!,
          }),
          diskManager: disk!,
          liveRuntimeRegistry: registry,
          secretBroker: new InMemoryBackendRuntimeSecretBroker(),
          generatedSecretFilesystem: new TmpfsGeneratedSecretFilesystem({
            rootDir: configuredPaths.generatedSecretRoot,
            forbiddenRoots: [configuredPaths.bundlesRootDir],
          }),
          temporaryDatabaseProvisioner: provisioner,
          databaseCredentialFilesystem: new TmpfsDatabaseCredentialFilesystem({
            rootDir: configuredPaths.databaseCredentialRoot,
            forbiddenRoots: [
              configuredPaths.bundlesRootDir,
              configuredPaths.generatedSecretRoot,
            ],
          }),
          userEnvironmentSource: broker,
          userEnvironmentFilesystem: new TmpfsUserEnvironmentFilesystem({
            rootDir: configuredPaths.userEnvironmentRoot,
            forbiddenRoots: [configuredPaths.bundlesRootDir],
          }),
          installTimeoutMs: 120_000,
          readinessTimeoutMs: 30_000,
          maxRuntimeMs: 360_000,
        })
        await step("fullstack", "FULLSTACK_FAILED", async () => {
          const artifacts = new InMemoryPreviewArtifactCache()
          const artifactId = `combined-artifact-${randomUUID()}`
          const expiresAt = new Date(Date.now() + 600_000)
          const runnerVersion = "m12-combined-d2a"
          await artifacts.put(
            await createBuildCacheKey(frontendPlan, runnerVersion),
            artifactId,
            expiresAt,
          )
          const frontend = new PreviewControlPlane(
            { resolve: async () => frontendPlan },
            new InMemoryPreviewJobStore(),
            new InMemoryPreviewQueue(),
            artifacts,
            {
              sign: async () => ({
                url: "https://artifact.invalid/",
                expiresAt: expiresAt.toISOString(),
              }),
            },
            quota,
            { runnerVersion },
          )
          const routingActivator = new FullStackRoutingActivator({
            fullStackControlPlane: fullStack!,
            backendControlPlane: backend!,
            liveRuntimeResolver: registry,
            artifactStore: {
              get: async (id) => (id === artifactId ? { expiresAt } : null),
            },
            baseDomain: "combined.invalid",
          })
          const parentSupervisor = new FullStackPreviewSupervisor(
            fullStack!,
            frontend,
            artifacts,
            backend!,
            {
              pollIntervalMs: 25,
              routingActivator,
              liveRuntimeResolver: registry,
            },
          )
          await fullStack!.create(
            {
              contractVersion: "fullstack-v1",
              repository,
              frontendTarget: { sourceRoot: "frontend" },
              backendSourceRoot: "backend",
              userEnvironment: [
                { name: "APP_GREETING", value: "Hello Peephole M12" },
              ],
            },
            `combined-${randomUUID()}`,
            requester,
          )
          const parentJob = await takeCombinedParent(fullStore, parentId)
          fullStackRun = parentSupervisor
            .run(parentJob, { signal: parentAbort.signal })
            .then(
              () => true,
              () => false,
            )
          const lease = await poll(
            async () => backendQueue.lease("combined-worker"),
            10_000,
            "FULLSTACK_FAILED",
          )
          backendRun = supervisor
            .run(lease.job, { signal: backendAbort.signal })
            .then(
              () => true,
              () => false,
            )
        })
        await step("readiness", "READINESS_FAILED", async () => {
          await poll(
            async () => {
              const child = await backend!.get(runtimeId, requester)
              requireCombined(child.status !== "failed", "READINESS_FAILED")
              return child.status === "running" ? true : null
            },
            200_000,
            "READINESS_FAILED",
          )
          await poll(
            async () =>
              (await fullStore.get(parentId))?.status === "ready" ? true : null,
            10_000,
            "FULLSTACK_FAILED",
          )
        })
        await step("materials", "MATERIAL_DELIVERY_FAILED", async () => {
          const allocations = await disk!.listOwnedAllocations()
          requireCombined(allocations.length === 1, "MATERIAL_DELIVERY_FAILED")
          const config = JSON.parse(
            await readFile(
              path.join(allocations[0]!.bundleDir, "config.json"),
              "utf8",
            ),
          ) as {
            process: { env: string[] }
            mounts: Array<{
              source: string
              destination: string
              options: string[]
            }>
          }
          const expected = [
            [
              SANDBOX_GENERATED_SECRET_FILE,
              `${configuredPaths.generatedSecretRoot}/${runtimeId}/env`,
            ],
            [
              SANDBOX_DATABASE_CREDENTIAL_FILE,
              `${configuredPaths.databaseCredentialRoot}/${runtimeId}/database-url`,
            ],
            [
              SANDBOX_USER_ENVIRONMENT_FILE,
              `${configuredPaths.userEnvironmentRoot}/${runtimeId}/user-env`,
            ],
          ]
          requireCombined(
            config.process.env.length === 3 &&
              new Set(config.process.env).size === 3 &&
              config.process.env.every((entry) =>
                ["PORT=3000", "HOST=0.0.0.0", "NODE_ENV=production"].includes(
                  entry,
                ),
              ),
            "MATERIAL_DELIVERY_FAILED",
          )
          const identities = new Set<string>()
          for (const [destination, source] of expected) {
            const mounts = config.mounts.filter(
              (mount) => mount.destination === destination,
            )
            requireCombined(
              mounts.length === 1 &&
                mounts[0]!.source === source &&
                ["ro", "nosuid", "nodev", "noexec"].every((flag) =>
                  mounts[0]!.options.includes(flag),
                ),
              "MATERIAL_DELIVERY_FAILED",
            )
            const stats = await lstat(source!)
            requireCombined(
              stats.isFile() &&
                !stats.isSymbolicLink() &&
                stats.uid === 65534 &&
                stats.gid === 65534 &&
                (stats.mode & 0o777) === 0o600,
              "MATERIAL_DELIVERY_FAILED",
            )
            identities.add(`${stats.dev}:${stats.ino}`)
          }
          requireCombined(
            identities.size === 3 &&
              (await leases!.listOwnedLeases()).some(
                (lease) =>
                  lease.policy === "ingress-only" &&
                  lease.temporaryDatabaseAccess,
              ),
            "MATERIAL_DELIVERY_FAILED",
          )
        })
        const target = registry.resolve(runtimeId)
        requireCombined(target, "READINESS_FAILED")
        await step("config", "CONFIG_CHECK_FAILED", async () => {
          requireCombined(
            (await checkHttp(
              target,
              "/health",
              (body) => body.status === "ok",
            )) &&
              (await checkHttp(
                target,
                "/api/config-check",
                (body) =>
                  body.configured === true &&
                  body.value === "Hello Peephole M12",
              )),
            "CONFIG_CHECK_FAILED",
          )
        })
        await step("query", "DATABASE_QUERY_FAILED", async () => {
          // The unmodified pinned fixture connects as the generated tenant,
          // executes CREATE TABLE and SELECT 1 before returning connected:true.
          requireCombined(
            await checkHttp(
              target,
              "/api/db-check",
              (body) => body.connected === true,
            ),
            "DATABASE_QUERY_FAILED",
          )
        })
        await step("secret", "SECRET_CHECK_FAILED", async () => {
          // Discard the fixture's digest during parsing; never retain/report it.
          requireCombined(
            await checkHttp(
              target,
              "/api/secret-check",
              (body) => body.configured === true,
            ),
            "SECRET_CHECK_FAILED",
          )
        })
        await step("stop", "STOP_FAILED", async () => {
          await fullStack!.cancel(parentId, requester)
          requireCombined(
            (await bounded(fullStackRun!, 60_000)) &&
              (await bounded(backendRun!, 60_000)),
            "STOP_FAILED",
          )
          requireCombined(
            (await backend!.get(runtimeId, requester)).status === "stopped" &&
              (await fullStore.get(parentId))?.status === "stopped" &&
              !registry.resolve(runtimeId),
            "STOP_FAILED",
          )
        })
      } catch (error) {
        failure =
          error instanceof CombinedHarnessError ? error.code : "SCENARIO_FAILED"
      } finally {
        // Existing lifecycle owns reclamation; never drop arbitrary roles/DBs
        // or forcibly delete runsc/netns resources to make the test pass.
        const stopped = await attemptCombinedCleanup([
          async () => {
            if (fullStack) await fullStack.cancel(parentId, requester)
          },
          async () => {
            if (backend)
              await backend.cancelForOrchestration(runtimeId, requester.subject)
          },
          async () => {
            const childDone = !backendRun || (await bounded(backendRun, 60_000))
            const parentDone =
              !fullStackRun || (await bounded(fullStackRun, 60_000))
            if (!childDone || !parentDone) {
              // Abort only after normal cancellation fails to finish. Preserve
              // every root; never force-delete resources or claim clean Stop.
              backendAbort.abort()
              parentAbort.abort()
              if (backendRun) await bounded(backendRun, 30_000)
              if (fullStackRun) await bounded(fullStackRun, 30_000)
              throw new CombinedHarnessError("STOP_FAILED")
            }
          },
        ])
        if (runs && paths && disk && leases && ownership && catalog) {
          try {
            requireCombined(stopped && !postgresPoolError, "RECLAMATION_FAILED")
            const records = await ownership.listAll()
            requireCombined(
              stages.query !== "PASS" || records.length === 1,
              "RECLAMATION_FAILED",
            )
            for (const record of records) {
              requireCombined(
                record.previewId === parentId &&
                  record.backendRuntimeId === runtimeId &&
                  record.status === "revoked",
                "RECLAMATION_FAILED",
              )
              const presence = await catalog.inspectResource(record.resourceId)
              requireCombined(
                !presence.database && !presence.role,
                "RECLAMATION_FAILED",
              )
            }
            requireCombined(
              (await disk.listOwnedAllocations()).length === 0 &&
                (await leases.listOwnedLeases()).length === 0,
              "RECLAMATION_FAILED",
            )
            await requireNoPeepholeNetworks(runner, "RECLAMATION_FAILED")
            const containers = await runner.run(
              "runsc",
              ["--root", paths.runscRootDir, "list", "--format=json"],
              { timeoutMs: 10_000 },
            )
            requireCombined(
              containers.exitCode === 0 &&
                !containers.timedOut &&
                Array.isArray(JSON.parse(containers.stdout)) &&
                JSON.parse(containers.stdout).length === 0,
              "RECLAMATION_FAILED",
            )
            for (const root of [
              paths.generatedSecretRoot,
              paths.databaseCredentialRoot,
              paths.userEnvironmentRoot,
              paths.bundlesRootDir,
              paths.leaseDir,
            ])
              requireCombined(
                (await readdir(root)).length === 0,
                "RECLAMATION_FAILED",
              )
            requireCombined(
              (await reconcileDedicatedRunscStateForCleanup(paths.runscRootDir))
                .ok,
              "RECLAMATION_FAILED",
            )
            for (const run of [runs.runsc, runs.tmpfs, runs.workspace])
              requireCombined(
                (await removeOwnedRunDirectory(run)).removed,
                "RECLAMATION_FAILED",
              )
            stages.reclamation = "PASS"
          } catch {
            stages.reclamation = "FAIL"
            failure ??= "RECLAMATION_FAILED"
          }
        } else if (allocationAttempted) {
          // Partial setup is preserved: do not claim the roots are safe to
          // delete without every authoritative component/resource inspection.
          stages.reclamation = "FAIL"
          failure ??= "RECLAMATION_FAILED"
        }
        if (tenant) {
          try {
            await tenant.close()
          } catch {
            stages.reclamation = "FAIL"
            failure ??= "RECLAMATION_FAILED"
          }
        }
        if (oldTmpdir === undefined) delete process.env.TMPDIR
        else process.env.TMPDIR = oldTmpdir
        // Exactly this allowlisted report; never serialize a caught exception,
        // workspace/config, HTTP body, material, SQL result or process output.
        process.stdout.write(
          `[m12-combined] ${JSON.stringify({ runtimeId, diagnostic: safeDiagnostic(diagnostic), stages, result: stages.reclamation === "FAIL" ? "BLOCKED" : failure ? "FAIL" : "PASS", failureCode: failure, resourcesPreserved: stages.reclamation === "FAIL" })}\n`,
        )
      }
      if (failure) throw new CombinedHarnessError(failure)
    }, 480_000)
  },
)

async function requireNoPeepholeNetworks(
  runner: ProcessRunner,
  code: CombinedCode,
): Promise<void> {
  for (const [command, args] of [
    ["ip", ["netns", "list"]],
    ["ip", ["-o", "link", "show"]],
    ["iptables", ["-S"]],
    ["iptables", ["-t", "nat", "-S"]],
    ["ip6tables", ["-S"]],
    ["ip6tables", ["-t", "nat", "-S"]],
  ] as const) {
    const result = await runner.run(command, [...args], { timeoutMs: 10_000 })
    requireCombined(
      result.exitCode === 0 &&
        !result.timedOut &&
        !/(?:peephole-|\b(?:veph|vpph|ppe|ppi|ppr)\d+\b)/.test(result.stdout),
      code,
    )
  }
}

async function poll<T>(
  read: () => Promise<T | null>,
  timeout: number,
  code: CombinedCode,
): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== null) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new CombinedHarnessError(code)
}
async function bounded(
  result: Promise<boolean>,
  timeout: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      result,
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeout)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
function checkHttp(
  target: { host: string; port: number },
  pathname: string,
  valid: (body: Record<string, unknown>) => boolean,
): Promise<boolean> {
  return new Promise((resolve) => {
    const request = get(
      {
        hostname: target.host,
        port: target.port,
        path: pathname,
        timeout: 5_000,
      },
      (response) => {
        let raw = ""
        response.on("data", (chunk) => {
          raw += String(chunk)
          if (Buffer.byteLength(raw) > 16_384) {
            response.destroy()
            resolve(false)
          }
        })
        response.on("error", () => resolve(false))
        response.on("end", () => {
          try {
            resolve(
              response.statusCode === 200 &&
                valid(
                  JSON.parse(raw, (key, value: unknown) =>
                    key === "sha256" ? undefined : value,
                  ) as Record<string, unknown>,
                ),
            )
          } catch {
            resolve(false)
          }
        })
      },
    )
    request.on("timeout", () => {
      request.destroy()
      resolve(false)
    })
    request.on("error", () => resolve(false))
  })
}
