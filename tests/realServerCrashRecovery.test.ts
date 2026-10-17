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
  loopbackAccepts,
  loopbackRequest,
  newServerNonce,
  OWNED_RESOURCE_KINDS,
  parseB2Fixture,
  realServerCrashEnabled,
  reverifyOwnedServer,
  SERVER_LISTENING_MARKER,
  spawnOwnedServer,
  syntheticEnvironment,
  syntheticServerSecrets,
  thawOwnedServer,
  linuxProcessInspection,
  type B2Fixture,
  type BoundaryObservation,
  type OwnedResourceCounts,
  type OwnedServer,
  type ServerPorts,
  type ServerRoots,
} from "./support/serverCrashHarness"

const ENTRY = path.resolve("services/production/server.ts")
const PREVIEW_TIMEOUT_MS = 15 * 60_000

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

describe.skipIf(!realServerCrashEnabled(process.env))(
  "B2 real server crash and startup recovery (Linux opt-in, test-owned server child)",
  () => {
    const servers: OwnedServer[] = []
    let runs: M12RunDirectories | undefined
    let database: PgPoolDatabase | undefined

    afterAll(async () => {
      // Graceful stop of any still-running owned child; a frozen child is
      // thawed first. Nothing outside the owned handles is ever signalled.
      for (const server of servers) {
        if (server.child.exitCode !== null || server.child.signalCode !== null)
          continue
        try {
          await reverifyOwnedServer(server, linuxProcessInspection)
          server.child.kill("SIGCONT")
          server.child.kill("SIGTERM")
          await Promise.race([
            server.exited,
            new Promise((resolve) => setTimeout(resolve, 60_000)),
          ])
        } catch {
          // Ownership no longer provable: never signal it.
        }
      }
      await database?.close()
      if (runs) {
        const preserved = await releaseOwnedRunDirectories([
          runs.workspace,
          runs.runsc,
          runs.tmpfs,
        ])
        if (preserved.length > 0)
          process.stdout.write(
            `[b2-server-crash-preserved] ${String(preserved.length)} run directories kept for inspection\n`,
          )
      }
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
        const existing = await database.query<{ rows: string }>(
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
        const baselineNetwork = await networkState(linuxResourceAuditOperations)
        // Every Peephole-shaped network object must be attributable to this run.
        expect(baselineNetwork).toEqual({ namespaces: 0, links: 0, rules: 0 })

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
          c: (await issuer.issue(`b2-${runTag}-c`)).token,
        }
        const forbidden = [
          databaseUrl,
          secrets.sessionSigningSecret,
          secrets.oauthClientSecret,
          secrets.oauthStateSecret,
          tokens.a,
          tokens.b,
          tokens.c,
          ...userEnvironment.map((entry) => entry.value),
        ]
        const evidence = (record: Parameters<typeof formatB2Evidence>[0]) =>
          process.stdout.write(
            `${formatB2Evidence(record, [...forbidden, ...nonces])}\n`,
          )

        const start = async (overrides?: Partial<Record<string, string>>) => {
          const nonce = newServerNonce()
          nonces.push(nonce)
          const server = await spawnOwnedServer({
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
          servers.push(server)
          return server
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
        const admit = async (token: string, key: string) => {
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
          expect(response?.status).toBe(202)
          return (response?.json as { preview: FullStackPreview }).preview.id
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
        const r0 = await start({ PEEPHOLE_GENERATED_SECRET_ROOT: notTmpfs })
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
          schema: "peephole-b2-server-crash/v1",
          scenario: "R0",
          verdict:
            listenerGatedOnFailedRecovery === null
              ? "INCONCLUSIVE"
              : listenerGatedOnFailedRecovery
                ? "PASS"
                : "FAIL",
          code: "STARTUP_FAILURE_LISTENER_GATE",
          sourceSha,
          stages: ["spawn", "capability-failure", "exit-observed"],
        })
        expect(listenerGatedOnFailedRecovery).toBe(true)

        // ------------------------------------------- first server and A ready
        const first = await start()
        expect(await waitFor(healthy, 180_000)).toBe(true)
        const a = await admit(tokens.a, `b2-${runTag}-a`)
        const aReady = await waitFor(
          async () => {
            const preview = await getPreview(a, tokens.a)
            if (preview?.status === "failed") return preview
            return preview?.status === "ready" ? preview : undefined
          },
          PREVIEW_TIMEOUT_MS,
          2_000,
        )
        expect(aReady?.status).toBe("ready")

        // C occupies the single orchestration slot; B is then admitted and waits.
        const c = await admit(tokens.c, `b2-${runTag}-c`)
        await waitFor(
          async () => {
            const preview = await getPreview(c, tokens.c)
            return preview &&
              [
                "building_frontend",
                "starting_backend",
                "awaiting_activation",
              ].includes(preview.status)
              ? true
              : undefined
          },
          PREVIEW_TIMEOUT_MS,
          500,
        )
        const b = await admit(tokens.b, `b2-${runTag}-b`)
        const aRouteStatus = await routeStatus(aReady?.url ?? null)

        // ------------------------------------- freeze, observe, then SIGKILL
        expect(await findProductionHostMarkers()).toEqual([])
        await freezeOwnedServer(first, process.env)
        const [aRow, bRow, cRow] = [
          await durable(a),
          await durable(b),
          await durable(c),
        ]
        const observation: BoundaryObservation = {
          frozen: true,
          aStatus: aRow?.status ?? null,
          aRouteStatus,
          bStatus: bRow?.status ?? null,
          bQueueStatus: bRow?.queue_status ?? null,
          cStatus: cRow?.status ?? null,
        }
        const boundary = classifyBoundary(observation)
        if (!boundary.h1 || !boundary.h2) {
          // No crash without proven boundaries: resume and stop normally.
          await thawOwnedServer(first, process.env)
          evidence({
            schema: "peephole-b2-server-crash/v1",
            scenario: "H2",
            verdict: "INCONCLUSIVE",
            code: "BOUNDARY_NOT_REACHED",
            sourceSha,
            stages: ["frozen", "boundary-rejected", "thawed"],
          })
        }
        expect(boundary).toMatchObject({ h1: true, h2: true })
        const crash = await crashOwnedServer(first, process.env)

        // ---------------------------------------------- fresh server process
        const second = await start()
        const freshProcess =
          second.identity.pid !== first.identity.pid ||
          second.identity.startTime !== first.identity.startTime
        expect(await waitFor(healthy, 180_000, 100)).toBe(true)
        // Probed immediately at the first answer: recovery must already be done.
        const aFirst = await getPreview(a, tokens.a)
        const cFirst = await getPreview(c, tokens.c)
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

        // Normal stop of the recovered server; its own stop is not a crash.
        second.child.kill("SIGTERM")
        const secondExit = await Promise.race([
          second.exited,
          new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), 120_000),
          ),
        ])
        expect(secondExit).toEqual({ code: 0, signal: null })

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
        const resources = await inventory()

        // Fresh startup reapers again: they must find nothing left to change.
        let repeatedReap: { changed: number; failed: boolean }
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
          const changed =
            reaped.length +
            OWNED_RESOURCE_KINDS.filter(
              (kind) => after[kind] !== resources[kind],
            ).length
          repeatedReap = { changed, failed: false }
        } catch {
          repeatedReap = { changed: 0, failed: true }
        }

        const restart = { crash, freshProcess }
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
        const auxiliary =
          boundary.auxiliary &&
          cFirst?.status === "failed" &&
          cFirst.errorCode === "ORCHESTRATION_UNAVAILABLE"
        const stages = [
          "frozen",
          "boundary-proven",
          "sigkill",
          "fresh-start",
          "reconciled",
          "graceful-stop",
          "inventory",
          "repeat-reap",
        ]
        evidence({
          schema: "peephole-b2-server-crash/v1",
          scenario: "H1",
          verdict: h1.verdict,
          code: h1.code,
          sourceSha,
          stages,
        })
        evidence({
          schema: "peephole-b2-server-crash/v1",
          scenario: "H2",
          verdict: h2.verdict,
          code: h2.code,
          sourceSha,
          stages,
          counts: { ...resources, repeatReapChanged: repeatedReap.changed },
        })
        evidence({
          schema: "peephole-b2-server-crash/v1",
          scenario: "AUXILIARY",
          verdict: boundary.auxiliary
            ? auxiliary
              ? "PASS"
              : "FAIL"
            : "NOT_RUN",
          code: "IN_PROGRESS_ORCHESTRATION_UNAVAILABLE",
          sourceSha,
          stages,
        })

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
