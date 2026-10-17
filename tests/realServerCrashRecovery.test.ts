/**
 * B2 real server crash and fresh-startup recovery (Linux opt-in ONLY).
 *
 * Skipped unless PEEPHOLE_B2_REAL_SERVER_CRASH, PEEPHOLE_REAL_GVISOR_TESTS and
 * PEEPHOLE_M12_REAL_GVISOR_TESTS are each exactly "1" on Linux. Runs the
 * unmodified services/production/server.ts as a harness-owned child on a
 * separately approved, credential-free, non-Production VM, against the M12
 * test roots, a dedicated empty loopback test database and a public fixture
 * repository. It never touches Production, a systemd service or a real
 * credential. See docs/M12_REAL_GVISOR_VERIFICATION.md (R5-3A).
 *
 * Boundary: the production server runs ONE FullStackPreviewWorkerLoop, which
 * awaits `worker.run()`; FullStackPreviewSupervisor.monitorLifecycle() keeps
 * that run alive while a preview is ready. So once A is ready it holds the
 * only orchestration slot (queue row `leased`), and B, admitted afterwards,
 * stays `queued` with its M12 values only in the in-memory broker.
 */
import { execFile, execFileSync } from "node:child_process"
import { mkdir, readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"

import { GeneratedSecretOrphanReaper } from "../services/preview-worker/gvisor/generatedSecretOrphanReaper"
import { GVisorOrphanReaper } from "../services/preview-worker/gvisor/gvisorOrphanReaper"
import { NetworkOrphanReaper } from "../services/preview-worker/gvisor/networkOrphanReaper"
import { LoopbackSandboxDiskManager } from "../services/preview-worker/gvisor/sandboxDisk"
import { NetworkLeaseManager } from "../services/preview-worker/gvisor/subnetAllocator"
import { UserEnvironmentOrphanReaper } from "../services/preview-worker/gvisor/userEnvironmentOrphanReaper"
import { readPostgresConfig } from "../services/preview-api/postgres/config"
import { PgPoolDatabase } from "../services/preview-api/postgres/database"
import { PreviewSessionIssuer } from "../services/preview-api/previewSession"
import {
  FULLSTACK_PREVIEW_CONTRACT_VERSION,
  type FullStackPreview,
} from "../types/fullstackPreview"
import {
  createOwnedRunSet,
  deriveM12ComponentPaths,
  findProductionHostMarkers,
  mountsWithin,
  protectedResourceRoots,
  readM12HarnessConfig,
  releaseOwnedRunDirectories,
  type M12RunDirectories,
} from "./support/m12RealGvisorHarness"
import { networkState } from "./support/m12ResourceAudit"
import { linuxResourceAuditOperations } from "./support/runM12JournalVerification"
import {
  assertDedicatedTestDatabaseUrl,
  assertRootsWithin,
  buildServerEnvironment,
  classifyBoundary,
  classifyH1,
  classifyH2,
  crashOwnedServer,
  formatB2Evidence,
  freeLoopbackPort,
  freezeOwnedServer,
  linuxProcessInspection,
  loopbackAccepts,
  loopbackRequest,
  newServerNonce,
  OWNED_RESOURCE_KINDS,
  parseB2Fixture,
  realServerCrashEnabled,
  reverifyOwnedServer,
  SERVER_LISTENING_MARKER,
  spawnOwnedServer,
  stopOwnedServer,
  syntheticEnvironment,
  syntheticServerSecrets,
  thawOwnedServer,
  type B2Evidence,
  type B2Fixture,
  type BoundaryObservation,
  type OwnedResourceCounts,
  type OwnedServer,
  type ServerPorts,
  type ServerRoots,
  type UnverifiedChild,
} from "./support/serverCrashHarness"

const ENTRY = path.resolve("services/production/server.ts")
const PREVIEW_TIMEOUT_MS = 15 * 60_000

/** Resolves the probe's value, or `undefined` on timeout -- callers MUST
 * treat `undefined` as an unreached boundary. */
async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 1_000,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return undefined
}

async function entryCount(directory: string): Promise<number | null> {
  try {
    return (await readdir(directory)).length
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? 0 : null
  }
}

function runscContainers(runscRoot: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      "runsc",
      ["--root", runscRoot, "list", "--format", "json"],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(null)
        try {
          const parsed: unknown = JSON.parse(stdout.toString() || "null")
          resolve(
            parsed === null ? 0 : Array.isArray(parsed) ? parsed.length : null,
          )
        } catch {
          resolve(null)
        }
      },
    )
  })
}

class B2Inconclusive extends Error {
  constructor(readonly code: string) {
    super(`B2_INCONCLUSIVE_${code}`)
  }
}

describe.skipIf(!realServerCrashEnabled(process.env))(
  "B2 real server crash and startup recovery (Linux opt-in, test-owned server child)",
  () => {
    const servers: OwnedServer[] = []
    const unverified: UnverifiedChild[] = []
    let runs: M12RunDirectories | undefined
    let database: PgPoolDatabase | undefined

    afterAll(async () => {
      // Every signal below is preceded by a full identity re-verification
      // (PID, PPID, start time, executable, argv, nonce). A child whose
      // identity cannot be proven is never signalled; it, or any child that
      // did not stop, keeps the test roots for manual inspection.
      let manualInspection = false
      for (const server of servers) {
        if (server.child.exitCode !== null || server.child.signalCode !== null)
          continue
        try {
          const identity = await reverifyOwnedServer(
            server,
            linuxProcessInspection,
          )
          if (identity.state === "T") await thawOwnedServer(server, process.env)
          if ((await stopOwnedServer(server)) === null) manualInspection = true
        } catch {
          manualInspection = true
        }
      }
      for (const child of unverified)
        if (child.child.exitCode === null && child.child.signalCode === null)
          manualInspection = true
      await database?.close()
      if (!runs) return
      if (manualInspection) {
        process.stdout.write(
          "[b2-server-crash-manual-inspection] a server child could not be proven stopped; test roots preserved\n",
        )
        return
      }
      const preserved = await releaseOwnedRunDirectories([
        runs.workspace,
        runs.runsc,
        runs.tmpfs,
      ])
      if (preserved.length > 0)
        process.stdout.write(
          `[b2-server-crash-preserved] ${String(preserved.length)} run directories kept for inspection\n`,
        )
    })

    it(
      "R0/H1/H2: SIGKILL of the owned server, then fresh startup recovery",
      async () => {
        // ---------------------------------------------------------- preflight
        expect(process.getuid?.()).toBe(0)
        expect(await findProductionHostMarkers()).toEqual([])
        const config = await readM12HarnessConfig(process.env)
        const fixture: B2Fixture = parseB2Fixture(
          process.env.PEEPHOLE_B2_TEST_FIXTURE,
        )
        const databaseUrl = assertDedicatedTestDatabaseUrl(
          process.env.PEEPHOLE_B2_TEST_DATABASE_URL,
        )
        const sourceSha = execFileSync("git", ["rev-parse", "HEAD"])
          .toString()
          .trim()
        database = new PgPoolDatabase(
          readPostgresConfig({ PEEPHOLE_DATABASE_URL: databaseUrl }).pool,
        )
        const existing = await database.query<{ rows: string | null }>(
          "SELECT to_regclass('peephole_fullstack_previews')::text AS rows",
        )
        if (existing.rows[0]?.rows) {
          const count = await database.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM peephole_fullstack_previews",
          )
          // The reconciler acts on every row: refuse any non-empty database.
          expect(count.rows[0]?.n).toBe("0")
        }

        runs = await createOwnedRunSet(config)
        const paths = deriveM12ComponentPaths(
          config,
          runs,
          protectedResourceRoots(process.env),
        )
        const roots: ServerRoots = {
          baseRootfs: paths.baseRootfsImage,
          bundlesDir: paths.bundlesRootDir,
          runscRoot: paths.runscRootDir,
          networkLeaseDir: paths.leaseDir,
          generatedSecretRoot: paths.generatedSecretRoot,
          artifactStorageDir: path.join(runs.workspace.path, "artifacts"),
          databaseCredentialRoot: paths.databaseCredentialRoot,
          userEnvironmentRoot: paths.userEnvironmentRoot,
        }
        assertRootsWithin(roots, [
          runs.workspace.path,
          runs.runsc.path,
          runs.tmpfs.path,
          config.baseRootfs,
        ])
        for (const directory of [
          roots.bundlesDir,
          roots.runscRoot,
          roots.networkLeaseDir,
          roots.artifactStorageDir,
          roots.generatedSecretRoot,
          roots.databaseCredentialRoot,
          roots.userEnvironmentRoot,
        ])
          await mkdir(directory, { recursive: true, mode: 0o700 })

        const runDirectories = [
          runs.workspace.path,
          runs.runsc.path,
          runs.tmpfs.path,
        ]
        const mountBaseline = async () => {
          const info = await readFile("/proc/self/mountinfo", "utf8")
          return runDirectories
            .flatMap((root) => mountsWithin(root, info))
            .sort()
        }
        const baselineMounts = await mountBaseline()
        // Every Peephole-shaped network object must be attributable to this run.
        expect(await networkState(linuxResourceAuditOperations)).toEqual({
          namespaces: 0,
          links: 0,
          rules: 0,
        })

        const ports: ServerPorts = {
          api: await freeLoopbackPort(),
          artifact: await freeLoopbackPort(),
          tlsAsk: await freeLoopbackPort(),
        }
        const secrets = syntheticServerSecrets()
        const runTag = newServerNonce().slice(0, 12)
        const userEnvironment = syntheticEnvironment(
          fixture.environmentNames,
          runTag,
        )
        const nonces: string[] = []
        const issuer = new PreviewSessionIssuer(secrets.sessionSigningSecret)
        const tokens = {
          a: (await issuer.issue(`b2-${runTag}-a`)).token,
          b: (await issuer.issue(`b2-${runTag}-b`)).token,
        }
        const forbidden = [
          databaseUrl,
          secrets.sessionSigningSecret,
          secrets.oauthClientSecret,
          secrets.oauthStateSecret,
          tokens.a,
          tokens.b,
          ...userEnvironment.map((entry) => entry.value),
        ]
        const evidence = (
          record: Omit<B2Evidence, "schema" | "sourceSha">,
        ): void => {
          process.stdout.write(
            `${formatB2Evidence(
              { schema: "peephole-b2-server-crash/v1", sourceSha, ...record },
              [...forbidden, ...nonces],
            )}\n`,
          )
        }
        /** Records H1 and H2 as INCONCLUSIVE and stops the run. */
        const inconclusive = (code: string, stages: string[]): never => {
          for (const scenario of ["H1", "H2"] as const)
            evidence({ scenario, verdict: "INCONCLUSIVE", code, stages })
          throw new B2Inconclusive(code)
        }

        const start = async (
          stage: string,
          overrides?: Partial<Record<string, string>>,
        ): Promise<OwnedServer> => {
          const nonce = newServerNonce()
          nonces.push(nonce)
          const result = await spawnOwnedServer({
            repository: process.cwd(),
            entry: ENTRY,
            environment: buildServerEnvironment({
              databaseUrl,
              roots,
              ports,
              secrets,
              nonce,
              overrides,
            }),
            nonce,
          })
          if (result.kind === "UNVERIFIED") {
            // Never signalled; roots are preserved by afterAll while it lives.
            unverified.push(result.unverified)
            return inconclusive(`IDENTITY_${result.unverified.reason}`, [stage])
          }
          servers.push(result.server)
          return result.server
        }
        const healthy = async () =>
          (
            await loopbackRequest({
              port: ports.api,
              method: "GET",
              path: "/healthz",
            })
          )?.status === 200
            ? true
            : undefined
        const getPreview = async (id: string, token: string) => {
          const response = await loopbackRequest({
            port: ports.api,
            method: "GET",
            path: `/v1/fullstack-previews/${id}`,
            headers: { authorization: `Bearer ${token}` },
          })
          return response?.status === 200
            ? (response.json as FullStackPreview)
            : undefined
        }
        const admit = async (token: string, key: string, stage: string) => {
          const response = await loopbackRequest({
            port: ports.api,
            method: "POST",
            path: "/v1/fullstack-previews",
            headers: {
              authorization: `Bearer ${token}`,
              "idempotency-key": key,
            },
            body: {
              contractVersion: FULLSTACK_PREVIEW_CONTRACT_VERSION,
              repository: {
                repositoryId: fixture.repositoryId,
                owner: fixture.owner,
                name: fixture.name,
                commitSha: fixture.commitSha,
              },
              frontendTarget: { sourceRoot: fixture.frontendSourceRoot },
              backendSourceRoot: fixture.backendSourceRoot,
              userEnvironment,
            },
          })
          const id = (response?.json as { preview?: { id?: unknown } } | null)
            ?.preview?.id
          if (response?.status !== 202 || typeof id !== "string")
            return inconclusive("ADMISSION_REJECTED", [stage])
          return id
        }
        const routeStatus = async (previewUrl: string | null) => {
          if (!previewUrl) return null
          const response = await loopbackRequest({
            port: ports.artifact,
            method: "GET",
            path: "/",
            headers: { host: new URL(previewUrl).host },
          })
          return response?.status ?? null
        }
        const durable = async (id: string) => {
          const row = await database?.query<{
            status: string
            error_code: string | null
            queue_status: string | null
          }>(
            `SELECT p.status, p.error_code, q.status AS queue_status
             FROM peephole_fullstack_previews p
             LEFT JOIN peephole_fullstack_queue q ON q.preview_id = p.id
            WHERE p.id = $1`,
            [id],
          )
          return row?.rows[0]
        }

        // -------------------------- R0: failed recovery never opens a listener
        // A generated-secret root that is not memory-backed fails the startup
        // capability gate after the physical reapers and before reconciliation.
        const notTmpfs = path.join(runs.workspace.path, "r0-not-tmpfs")
        await mkdir(notTmpfs, { mode: 0o700 })
        const r0 = await start("r0-spawn", {
          PEEPHOLE_GENERATED_SECRET_ROOT: notTmpfs,
        })
        let r0Listened = false
        const r0Exit = await waitFor(
          async () => {
            if (await loopbackAccepts(ports.api)) r0Listened = true
            return r0.child.exitCode !== null || r0.child.signalCode !== null
              ? await r0.exited
              : undefined
          },
          120_000,
          100,
        )
        if (r0Exit === undefined) await stopOwnedServer(r0)
        const listenerGatedOnFailedRecovery =
          r0Exit === undefined
            ? null
            : r0Exit.code === 1 &&
              r0Exit.signal === null &&
              !r0Listened &&
              !r0.stdoutLines.some((line) =>
                line.includes(SERVER_LISTENING_MARKER),
              )
        evidence({
          scenario: "R0",
          verdict:
            listenerGatedOnFailedRecovery === null
              ? "INCONCLUSIVE"
              : listenerGatedOnFailedRecovery
                ? "PASS"
                : "FAIL",
          code: "STARTUP_FAILURE_LISTENER_GATE",
          stages: ["spawn", "capability-failure", "exit-observed"],
        })

        // -------------------- first server: A ready and holding the only slot
        const first = await start("first-spawn")
        if ((await waitFor(healthy, 180_000)) === undefined)
          inconclusive("FIRST_SERVER_NOT_HEALTHY", ["first-spawn"])
        const a = await admit(tokens.a, `b2-${runTag}-a`, "admit-a")
        const aReady = await waitFor(
          async () => {
            const preview = await getPreview(a, tokens.a)
            if (!preview) return undefined
            if (preview.status === "ready") return preview
            return [
              "failed",
              "stopped",
              "cancelled",
              "expired",
              "stopping",
            ].includes(preview.status)
              ? null
              : undefined
          },
          PREVIEW_TIMEOUT_MS,
          2_000,
        )
        if (!aReady) inconclusive("A_NOT_READY", ["admit-a", "await-ready"])

        // B is admitted only after A is ready, so the single loop is busy.
        const b = await admit(tokens.b, `b2-${runTag}-b`, "admit-b")
        const settled = await waitFor(
          async () => {
            const [aRow, bRow] = [await durable(a), await durable(b)]
            return aRow?.queue_status === "leased" &&
              bRow?.status === "queued" &&
              bRow.queue_status === "queued"
              ? true
              : undefined
          },
          30_000,
          500,
        )
        if (settled === undefined)
          inconclusive("B_NOT_QUEUED_BEHIND_A", ["admit-b", "await-queued"])
        const aRouteStatus = await routeStatus(aReady?.url ?? null)

        // ------------------------------------- freeze, observe, then SIGKILL
        expect(await findProductionHostMarkers()).toEqual([])
        await freezeOwnedServer(first, process.env)
        const [aRow, bRow] = [await durable(a), await durable(b)]
        const observation: BoundaryObservation = {
          frozen: true,
          aStatus: aRow?.status ?? null,
          aRouteStatus,
          aQueueStatus: aRow?.queue_status ?? null,
          bStatus: bRow?.status ?? null,
          bQueueStatus: bRow?.queue_status ?? null,
        }
        const boundary = classifyBoundary(observation)
        if (!boundary.h1 || !boundary.h2) {
          // No crash without proven boundaries: resume and stop normally.
          await thawOwnedServer(first, process.env)
          await stopOwnedServer(first)
          inconclusive("BOUNDARY_NOT_REACHED", [
            "frozen",
            "boundary-rejected",
            "thawed",
            "graceful-stop",
          ])
        }
        const crash = await crashOwnedServer(first, process.env)

        // ---------------------------------------------- fresh server process
        const second = await start("fresh-spawn")
        const freshProcess =
          second.identity.pid !== first.identity.pid ||
          second.identity.startTime !== first.identity.startTime
        if ((await waitFor(healthy, 180_000, 100)) === undefined)
          inconclusive("RESTART_NOT_HEALTHY", ["sigkill", "fresh-spawn"])
        // Probed immediately at the first answer: recovery must already be done.
        const aFirst = await getPreview(a, tokens.a)
        const aRouteStatusAfter = await routeStatus(aReady?.url ?? null)
        const aDurable = await durable(a)

        let userEnvironmentDelivered: boolean | null = false
        let bEverReady = false
        const bFinal = await waitFor(
          async () => {
            const files = await entryCount(roots.userEnvironmentRoot)
            if (files === null) userEnvironmentDelivered = null
            else if (files > 0 && userEnvironmentDelivered === false)
              userEnvironmentDelivered = true
            const preview = await getPreview(b, tokens.b)
            if (preview?.status === "ready") bEverReady = true
            return preview &&
              ["failed", "ready", "stopped", "cancelled", "expired"].includes(
                preview.status,
              )
              ? preview
              : undefined
          },
          PREVIEW_TIMEOUT_MS,
          1_000,
        )

        // Normal, re-verified stop of the recovered server; never a crash.
        const secondExit = await stopOwnedServer(second)

        // --------------------------- owned-resource inventory after recovery
        const diskManager = new LoopbackSandboxDiskManager({
          bundlesRootDir: roots.bundlesDir,
        })
        const inventory = async (): Promise<OwnedResourceCounts> => {
          const network = await networkState(
            linuxResourceAuditOperations,
          ).catch(() => null)
          const mounts = await mountBaseline().catch(() => null)
          return {
            loopDevices: await diskManager
              .listOwnedAllocations()
              .then((list) => list.length)
              .catch(() => null),
            networkLeases: await readdir(roots.networkLeaseDir)
              .then((names) => names.filter((n) => /^[0-9]+$/.test(n)).length)
              .catch(() => null),
            runscContainers: await runscContainers(roots.runscRoot),
            networkNamespaces: network?.namespaces ?? null,
            hostLinks: network?.links ?? null,
            firewallRules: network?.rules ?? null,
            generatedSecretFiles: await entryCount(roots.generatedSecretRoot),
            databaseCredentialFiles: await entryCount(
              roots.databaseCredentialRoot,
            ),
            userEnvironmentFiles: await entryCount(roots.userEnvironmentRoot),
            newMounts:
              mounts === null
                ? null
                : mounts.filter((m) => !baselineMounts.includes(m)).length,
          }
        }
        // Only after a proven normal stop; otherwise the inventory could race a
        // live server and is not evidence.
        const stoppedCleanly =
          secondExit !== null && secondExit.code === 0 && !secondExit.signal
        const resources = stoppedCleanly
          ? await inventory()
          : (Object.fromEntries(
              OWNED_RESOURCE_KINDS.map((kind) => [kind, null]),
            ) as OwnedResourceCounts)

        // Fresh startup reapers again: they must find nothing left to change.
        let repeatedReap: { changed: number; failed: boolean } | null = null
        if (stoppedCleanly) {
          try {
            const reaped = [
              ...(await new GVisorOrphanReaper({
                runscRootDir: roots.runscRoot,
                diskManager,
              }).reapAll()),
              ...(await new GeneratedSecretOrphanReaper({
                rootDir: roots.generatedSecretRoot,
              }).reapAll()),
              ...(await new UserEnvironmentOrphanReaper({
                rootDir: roots.userEnvironmentRoot,
              }).reapAll()),
            ]
            await new NetworkOrphanReaper({
              leaseManager: new NetworkLeaseManager({
                leaseDir: roots.networkLeaseDir,
              }),
            }).reapAll()
            const after = await inventory()
            repeatedReap = {
              changed:
                reaped.length +
                OWNED_RESOURCE_KINDS.filter(
                  (kind) => after[kind] !== resources[kind],
                ).length,
              failed: false,
            }
          } catch {
            repeatedReap = { changed: 0, failed: true }
          }
        }

        const restart = { crash, freshProcess }
        // Each scenario is judged on its own boundary and its own result.
        const h1 = classifyH1({
          ...restart,
          boundaryReached: boundary.h1,
          bStatus: bFinal?.status ?? null,
          bErrorCode: bFinal?.errorCode ?? null,
          bEverReady,
          userEnvironmentDelivered,
        })
        const h2 = classifyH2({
          ...restart,
          boundaryReached: boundary.h2,
          aStatusAtFirstResponse: aFirst?.status ?? null,
          aErrorCode: aFirst?.errorCode ?? null,
          aQueueStatus: aDurable?.queue_status ?? null,
          aRouteStatusAfter,
          resources,
          repeatedReap,
          listenerGatedOnFailedRecovery,
        })
        const stages = [
          "a-ready-leased",
          "b-queued",
          "frozen",
          "boundary-proven",
          "sigkill",
          "fresh-start",
          "reconciled",
          "graceful-stop",
          "inventory",
          "repeat-reap",
        ]
        evidence({ scenario: "H1", verdict: h1.verdict, code: h1.code, stages })
        evidence({
          scenario: "H2",
          verdict: h2.verdict,
          code: h2.code,
          stages,
          counts: {
            ...resources,
            repeatReapChanged: repeatedReap?.changed ?? null,
          },
        })

        expect(listenerGatedOnFailedRecovery).toBe(true)
        expect(h1).toEqual({
          verdict: "PASS",
          code: "CONFIGURATION_UNAVAILABLE",
        })
        expect(h2).toEqual({ verdict: "PASS", code: "RECOVERED" })
      },
      60 * 60_000,
    )
  },
)
