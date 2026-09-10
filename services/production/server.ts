import { GitHubClient } from "../../core/github/client"
import { KnownRepositoryFilesLoader } from "../../core/github/knownFiles"
import { GitHubAppOAuth } from "../preview-api/githubAppOAuth"
import { readGitHubAppOAuthConfig } from "../preview-api/githubAppOAuthConfig"
import { GitHubPreviewPlanResolver } from "../preview-api/githubPlanResolver"
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
import { LoopbackSandboxDiskManager } from "../preview-worker/gvisor/sandboxDisk"
import { PreviewWorkerLoop } from "../preview-worker/workerLoop"
import { PostgresProductionArtifactStore } from "../preview-api/postgres/productionArtifactStore"
import { ProductionArtifactTlsAskServer } from "./artifactTlsAskServer"
import { ProductionArtifactHost } from "./artifactHost"
import { readProductionConfig } from "./config"
import {
  ensureProductionDiskLayout,
  ensureProductionPreflight,
  ensureSandboxDiskCapability,
} from "./preflight"

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
 * Artifacts are served by `ProductionArtifactHost` (artifactHost.ts): one
 * fixed loopback listener routing by Host header to
 * `<artifact-id>.<PEEPHOLE_ARTIFACT_BASE_DOMAIN>`, with expiry persisted in
 * PostgreSQL so it survives a restart -- not
 * services/local-preview/artifactHost.ts's `LocalArtifactHost`, which is
 * development-only (one HTTP server per artifact on a random port,
 * in-memory expiry that a restart silently wipes). NOT done here: the
 * reverse proxy, DNS, and TLS that would actually make that domain
 * reachable from outside this host -- the listener stays loopback-only
 * until that separately-scoped step.
 */

async function main(): Promise<void> {
  const productionConfig = readProductionConfig(process.env)
  const diskManager = new LoopbackSandboxDiskManager({
    bundlesRootDir: productionConfig.bundlesRootDir,
    hardLimitBytes: productionConfig.sandboxDiskBytes,
    minimumHostReserveBytes: productionConfig.hostDiskReserveBytes,
  })

  await ensureProductionPreflight({
    baseRootfsImage: productionConfig.baseRootfsImage,
  })

  const database = new PgPoolDatabase(readPostgresConfig(process.env).pool)
  await applyPostgresMigrations(database)

  const orphanReaper = new GVisorOrphanReaper({
    runscRootDir: productionConfig.runscRootDir,
    maxAgeMs: productionConfig.orphanReaperMaxAgeMs,
    diskManager,
  })
  // Startup safety gate: no worker can allocate a new loop device or bundle
  // until all marker-owned resources left by an earlier process have been
  // reconciled against authoritative runsc state.
  await orphanReaper.reapAll()
  await ensureSandboxDiskCapability(diskManager)
  await ensureProductionDiskLayout({
    bundlesRootDir: productionConfig.bundlesRootDir,
    artifactStorageDir: productionConfig.artifactStorageDir,
  })

  const artifactStore = new PostgresProductionArtifactStore(database)
  const artifactHost = new ProductionArtifactHost({
    storageDir: productionConfig.artifactStorageDir,
    store: artifactStore,
    port: productionConfig.artifactPort,
    trustedAppOrigin: productionConfig.trustedAppOrigin,
    baseDomain: productionConfig.artifactBaseDomain,
  })
  const artifactAddress = await artifactHost.listen()
  const tlsAskServer = new ProductionArtifactTlsAskServer({
    store: artifactStore,
    port: productionConfig.artifactTlsAskPort,
    baseDomain: productionConfig.artifactBaseDomain,
  })
  // Rejection propagates to main's fatal startup handler; API and workers
  // cannot start without the ask listener.
  const tlsAskAddress = await tlsAskServer.listen()

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

  const sessionIssuer = new PreviewSessionIssuer(
    readRequiredSessionSigningSecret(),
  )
  const sessionAuth = new PreviewSessionAuth(sessionIssuer)
  const githubAppOAuth = new GitHubAppOAuth(
    readGitHubAppOAuthConfig(process.env),
  )
  const apiConfig = readPreviewApiServerConfig(process.env)
  const api = await startNodePreviewApi({
    controlPlane: composition.controlPlane,
    config: apiConfig,
    resolveRequester: (request) => sessionAuth.resolve(request),
    beginGitHubAuth: (request) =>
      githubAppOAuth.createAuthorizationUrl(request.url ?? "/"),
    completeGitHubAuth: (request) =>
      githubAppOAuth.completeCallback(request.url ?? "/"),
    issueSession: (_request, body) =>
      githubAppOAuth.issueSession(body, sessionIssuer),
    isReady: composition.isReady,
  })

  const worker = composeProductionWorker(composition.controlPlane, {
    baseRootfsImage: productionConfig.baseRootfsImage,
    bundlesRootDir: productionConfig.bundlesRootDir,
    runscRootDir: productionConfig.runscRootDir,
    artifactStorageDir: productionConfig.artifactStorageDir,
    diskManager,
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

  let maintenanceRunning: Promise<void> | undefined
  const maintain = () => {
    if (maintenanceRunning) return
    maintenanceRunning = Promise.all([orphanReaper.reap(), artifactHost.reap()])
      .then(() => undefined)
      .catch((error: unknown) =>
        console.error("[peephole] cleanup failed; will retry", error),
      )
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
    `[peephole] preview API listening on http://${api.address.address}:${api.address.port} (loopback only)`,
  )
  console.log(
    `[peephole] artifact host listening on http://${artifactAddress.host}:${String(artifactAddress.port)} (loopback only; not yet reachable as https://<artifact-id>.${productionConfig.artifactBaseDomain}/ -- no reverse proxy/DNS/TLS in front of it yet)`,
  )
  console.log(
    `[peephole] production worker running with real gVisor sandboxing, concurrency=${String(productionConfig.workerConcurrency)}`,
  )

  console.log(
    `[peephole] TLS ask listening on http://${tlsAskAddress.host}:${String(tlsAskAddress.port)}/check (loopback only)`,
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
    await tlsAskServer.close()
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
