import { GitHubClient } from "../../core/github/client"
import { KnownRepositoryFilesLoader } from "../../core/github/knownFiles"
import { GitHubPreviewPlanResolver } from "../preview-api/githubPlanResolver"
import { GitHubRequesterAuth } from "../preview-api/githubRequesterAuth"
import { PgPoolDatabase } from "../preview-api/postgres/database"
import { PreviewSessionAuth } from "../preview-api/previewSessionAuth"
import { PreviewSessionIssuer } from "../preview-api/previewSession"
import { readPostgresConfig } from "../preview-api/postgres/config"
import { applyPostgresMigrations } from "../preview-api/postgres/migrate"
import { composePostgresControlPlane } from "../preview-api/postgres/compose"
import { readPreviewApiServerConfig } from "../preview-api/serverConfig"
import { startNodePreviewApi } from "../preview-api/startNodeServer"
import { composeProductionWorker } from "../preview-worker/gvisor/composeProductionWorker"
import { GVisorOrphanReaper } from "../preview-worker/gvisor/gvisorOrphanReaper"
import { PreviewWorkerLoop } from "../preview-worker/workerLoop"
import { LocalArtifactHost } from "../local-preview/artifactHost"
import { readProductionConfig } from "./config"
import { ensureProductionPreflight } from "./preflight"

/**
 * Production launcher for a single untrusted-code preview host: real gVisor
 * sandboxing (`GVisorSandboxProvisioner`/`RunscCommandRunner`, wired by
 * `composeProductionWorker`) instead of
 * services/local-preview/devServer.ts's unsandboxed dev adapters
 * (`LocalDevSandboxProvisioner`/`HostCommandRunner`, via
 * `composeLocalDevWorker`). Kept as a fully separate entrypoint precisely so
 * devServer.ts's own behavior never has to change to accommodate this --
 * they share the Preview API/PostgreSQL control-plane wiring but nothing
 * about how jobs actually run.
 *
 * Refuses to start unless `ensureProductionPreflight()` confirms every host
 * prerequisite gVisor sandboxing/networking silently assumes -- see
 * preflight.ts for the full list and why each one matters.
 *
 * NOT done here: publicly-reachable, origin-isolated artifact hosting
 * (`peepholeusercontent.dev`-style domain separation). `LocalArtifactHost`
 * only ever binds loopback, so on a real host a preview's build runs for
 * real but its published output is not yet reachable off this box -- that
 * is the next, separately-scoped production-hosting step, not part of this
 * wiring.
 */

async function main(): Promise<void> {
  const productionConfig = readProductionConfig(process.env)

  await ensureProductionPreflight({
    baseRootfsImage: productionConfig.baseRootfsImage,
  })

  const database = new PgPoolDatabase(readPostgresConfig(process.env).pool)
  await applyPostgresMigrations(database)

  const artifactHost = new LocalArtifactHost({
    storageDir: productionConfig.artifactStorageDir,
  })
  const github = new GitHubClient({
    getToken: () => process.env.PEEPHOLE_GITHUB_TOKEN,
  })
  const planResolver = new GitHubPreviewPlanResolver(
    github,
    new KnownRepositoryFilesLoader(github),
  )

  const composition = composePostgresControlPlane({
    database,
    planResolver,
    artifactSigner: artifactHost,
    controlPlane: { runnerVersion: "production-1" },
  })

  const credentialAuth = new GitHubRequesterAuth()
  const sessionIssuer = new PreviewSessionIssuer(
    readRequiredSessionSigningSecret(),
  )
  const sessionAuth = new PreviewSessionAuth(sessionIssuer)
  const apiConfig = readPreviewApiServerConfig(process.env)
  const api = await startNodePreviewApi({
    controlPlane: composition.controlPlane,
    config: apiConfig,
    resolveRequester: (request) => sessionAuth.resolve(request),
    issueSession: async (request) => {
      const requester = await credentialAuth.resolve(request)
      return sessionIssuer.issue(requester.subject)
    },
    isReady: composition.isReady,
  })

  const worker = composeProductionWorker(composition.controlPlane, {
    baseRootfsImage: productionConfig.baseRootfsImage,
    bundlesRootDir: productionConfig.bundlesRootDir,
    runscRootDir: productionConfig.runscRootDir,
    artifactStorageDir: productionConfig.artifactStorageDir,
  })

  const workerController = new AbortController()
  const workerLoops = Array.from(
    { length: productionConfig.workerConcurrency },
    (_unused, index) =>
      new PreviewWorkerLoop(composition.queue, worker, {
        workerId: `production-${String(process.pid)}-${String(index)}`,
        onError: (error) =>
          console.error("[peephole] worker loop error", error),
      }),
  )
  const workerLoopsDone = Promise.all(
    workerLoops.map((loop) => loop.runUntilStopped(workerController.signal)),
  )

  const orphanReaper = new GVisorOrphanReaper({
    runscRootDir: productionConfig.runscRootDir,
    bundlesRootDir: productionConfig.bundlesRootDir,
    maxAgeMs: productionConfig.orphanReaperMaxAgeMs,
  })
  let maintenanceRunning: Promise<void> | undefined
  const maintain = () => {
    if (maintenanceRunning) return
    maintenanceRunning = Promise.all([orphanReaper.reap(), artifactHost.reap()])
      .then(() => undefined)
      .catch(() => console.error("[peephole] cleanup failed; will retry"))
      .finally(() => {
        maintenanceRunning = undefined
      })
  }
  maintain()
  const maintenanceTimer = setInterval(
    maintain,
    productionConfig.maintenanceIntervalMs,
  )
  maintenanceTimer.unref()

  console.log(
    `[peephole] preview API listening on http://${api.address.address}:${api.address.port}`,
  )
  console.log(
    `[peephole] production worker running with real gVisor sandboxing, concurrency=${String(productionConfig.workerConcurrency)}`,
  )

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(maintenanceTimer)
    console.log(`[peephole] received ${signal}, shutting down...`)
    workerController.abort()
    await workerLoopsDone.catch(() => undefined)
    await maintenanceRunning
    await api.stop()
    await artifactHost.close()
    await database.close()
    process.exit(0)
  }

  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
}

/**
 * Unlike services/local-preview/devServer.ts's fallback to a random,
 * process-lifetime-only secret (acceptable there -- a dev restart just
 * forces a silent re-login), production must not accept an unconfigured or
 * auto-generated signing secret: it would either sign every active user out
 * on every restart/deploy, or -- worse -- differ across a multi-process
 * deployment and make sessions issued by one process fail verification on
 * another.
 */
function readRequiredSessionSigningSecret(): string {
  const configured = process.env.PEEPHOLE_SESSION_SIGNING_SECRET

  if (!configured) {
    throw new Error(
      "PEEPHOLE_SESSION_SIGNING_SECRET is required in production.",
    )
  }

  return configured
}

main().catch((error) => {
  console.error("[peephole] production server failed to start", error)
  process.exit(1)
})
