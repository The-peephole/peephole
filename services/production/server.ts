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
import { VethNatNetworkProvisioner } from "../preview-worker/gvisor/networkNamespace"
import { NetworkOrphanReaper } from "../preview-worker/gvisor/networkOrphanReaper"
import { NetworkAllocationRegistry } from "../preview-worker/gvisor/networkAllocationRegistry"
import { LoopbackSandboxDiskManager } from "../preview-worker/gvisor/sandboxDisk"
import { NetworkLeaseManager } from "../preview-worker/gvisor/subnetAllocator"
import { PreviewWorkerLoop } from "../preview-worker/workerLoop"
import { PostgresProductionArtifactStore } from "../preview-api/postgres/productionArtifactStore"
import { PostgresPreviewQuota } from "../preview-api/postgres/quota"
import { GitHubBackendRuntimePlanResolver } from "../backend-runtime-api/githubRuntimePlanResolver"
import { BackendRuntimeControlPlane } from "../backend-runtime-api/controlPlane"
import {
  InMemoryBackendRuntimeQueue,
  InMemoryBackendRuntimeStore,
} from "../backend-runtime-api/inMemoryAdapters"
import { composeProductionBackendRuntime } from "../preview-worker/gvisor/composeProductionBackendRuntime"
import { BackendRuntimeWorkerLoop } from "../backend-runtime-worker/backendRuntimeWorkerLoop"
import { composePostgresFullStackPreview } from "../fullstack-preview-api/postgres/compose"
import { FullStackPreviewSupervisor } from "../fullstack-preview-worker/fullStackPreviewSupervisor"
import { FullStackPreviewWorkerLoop } from "../fullstack-preview-worker/fullStackPreviewWorkerLoop"
import { FullStackPreviewStartupReconciler } from "../fullstack-preview-worker/startupReconciler"
import { readProductionConfig } from "./config"
import { createProductionFullStackRoutingInfrastructure } from "./fullStackRoutingInfrastructure"
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
  const networkLeaseManager = new NetworkLeaseManager()
  const networkActivityRegistry = new NetworkAllocationRegistry()
  const networkOrphanReaper = new NetworkOrphanReaper({
    leaseManager: networkLeaseManager,
    activityRegistry: networkActivityRegistry,
  })
  // Network leases are the durable ownership source for netns/veth/firewall
  // cleanup. A failure here aborts startup before listeners or workers exist.
  await networkOrphanReaper.reapAll()
  await ensureSandboxDiskCapability(diskManager)
  await ensureProductionDiskLayout({
    bundlesRootDir: productionConfig.bundlesRootDir,
    artifactStorageDir: productionConfig.artifactStorageDir,
  })

  const artifactStore = new PostgresProductionArtifactStore(database)
  const routing = createProductionFullStackRoutingInfrastructure({
    database,
    artifactStore,
    artifactStorageDir: productionConfig.artifactStorageDir,
    artifactPort: productionConfig.artifactPort,
    artifactTlsAskPort: productionConfig.artifactTlsAskPort,
    artifactBaseDomain: productionConfig.artifactBaseDomain,
    trustedAppOrigin: productionConfig.trustedAppOrigin,
  })

  const github = new GitHubClient({
    getToken: () => process.env.PEEPHOLE_GITHUB_TOKEN,
  })
  const planResolver = new GitHubPreviewPlanResolver(
    github,
    new KnownRepositoryFilesLoader(github),
  )
  const backendPlanResolver = new GitHubBackendRuntimePlanResolver(github)
  // One explicit policy instance means standalone static and full-stack
  // admission use identical limits and durable scope-key semantics.
  const previewQuota = new PostgresPreviewQuota(database)

  const composition = composePostgresControlPlane({
    database,
    planResolver,
    artifactSigner: routing.artifactHost,
    quotaProvider: previewQuota,
    controlPlane: { runnerVersion: "production-2" },
  })
  const backendQueue = new InMemoryBackendRuntimeQueue()
  const backendControlPlane = new BackendRuntimeControlPlane(
    backendPlanResolver,
    new InMemoryBackendRuntimeStore(),
    backendQueue,
  )
  const fullStackComposition = composePostgresFullStackPreview({
    database,
    frontendPlanResolver: planResolver,
    backendPlanResolver,
    quota: previewQuota,
  })
  const routingActivator = routing.createActivator(
    fullStackComposition.controlPlane,
    backendControlPlane,
  )

  const networkProvisioner = new VethNatNetworkProvisioner({
    leaseManager: networkLeaseManager,
    activityRegistry: networkActivityRegistry,
  })
  const worker = composeProductionWorker(composition.controlPlane, {
    baseRootfsImage: productionConfig.baseRootfsImage,
    bundlesRootDir: productionConfig.bundlesRootDir,
    runscRootDir: productionConfig.runscRootDir,
    artifactStorageDir: productionConfig.artifactStorageDir,
    diskManager,
    networkProvisioner,
  })
  const backendSupervisor = composeProductionBackendRuntime(
    backendControlPlane,
    {
      baseRootfsImage: productionConfig.baseRootfsImage,
      bundlesRootDir: productionConfig.bundlesRootDir,
      runscRootDir: productionConfig.runscRootDir,
      diskManager,
      networkProvisioner,
      liveRuntimeRegistry: routing.liveRuntimeRegistry,
    },
  )
  const fullStackSupervisor = new FullStackPreviewSupervisor(
    fullStackComposition.controlPlane,
    composition.controlPlane,
    composition.artifacts,
    backendControlPlane,
    {
      routingActivator,
      liveRuntimeResolver: routing.liveRuntimeRegistry,
    },
  )

  // Physical orphan cleanup above is authoritative for old process-local
  // backend resources. Only now may durable parents be terminalized, and
  // this must finish before any listener can serve a stale ready row.
  await new FullStackPreviewStartupReconciler(
    fullStackComposition.store,
    fullStackComposition.queue,
    fullStackComposition.controlPlane,
    composition.controlPlane,
  ).reconcile()

  const artifactAddress = await routing.artifactHost.listen()
  const tlsAskAddress = await routing.tlsAskServer.listen()

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
    fullStackControlPlane: fullStackComposition.controlPlane,
    config: apiConfig,
    resolveRequester: (request) => sessionAuth.resolve(request),
    beginGitHubAuth: (request) =>
      githubAppOAuth.createAuthorizationUrl(request.url ?? "/"),
    completeGitHubAuth: (request) =>
      githubAppOAuth.completeCallback(request.url ?? "/"),
    issueSession: (_request, body) =>
      githubAppOAuth.issueSession(body, sessionIssuer),
    isReady: async () =>
      (await composition.isReady()) && (await fullStackComposition.isReady()),
  })

  const staticWorkerController = new AbortController()
  const backendWorkerController = new AbortController()
  const fullStackWorkerController = new AbortController()
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
    workerLoops.map((loop) =>
      loop.runUntilStopped(staticWorkerController.signal),
    ),
  )
  // Intentional order: child consumers are running before the one
  // full-stack orchestration loop can enqueue either child type.
  const backendWorkerLoop = new BackendRuntimeWorkerLoop(
    backendQueue,
    backendSupervisor,
    {
      workerId: `backend-production-${String(process.pid)}`,
      onError: (error) =>
        console.error("[peephole] backend worker loop error", error),
    },
  )
  const backendWorkerDone = backendWorkerLoop.runUntilStopped(
    backendWorkerController.signal,
  )
  const fullStackWorkerLoop = new FullStackPreviewWorkerLoop(
    fullStackComposition.queue,
    fullStackSupervisor,
    {
      workerId: `fullstack-production-${String(process.pid)}`,
      onError: (error) =>
        console.error("[peephole] full-stack worker loop error", error),
    },
  )
  const fullStackWorkerDone = fullStackWorkerLoop.runUntilStopped(
    fullStackWorkerController.signal,
  )

  let maintenanceRunning: Promise<void> | undefined
  const maintain = () => {
    if (maintenanceRunning) return
    maintenanceRunning = Promise.all([
      orphanReaper.reap(),
      networkOrphanReaper.reap(),
      routing.artifactHost.reap(),
    ])
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
    `[peephole] production workers running with real gVisor sandboxing, static concurrency=${String(productionConfig.workerConcurrency)}, backend concurrency=1, full-stack orchestration concurrency=1`,
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
    fullStackWorkerController.abort()
    await fullStackWorkerDone.catch(() => undefined)
    backendWorkerController.abort()
    await backendWorkerDone.catch(() => undefined)
    staticWorkerController.abort()
    await workerLoopsDone.catch(() => undefined)
    await maintenanceRunning
    await api.stop()
    await routing.tlsAskServer.close()
    await routing.artifactHost.close()
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
