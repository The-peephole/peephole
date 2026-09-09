import { randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

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
import { composeLocalDevWorker } from "../preview-worker/local/composeLocalDevWorker"
import { PreviewWorkerLoop } from "../preview-worker/workerLoop"
import { LocalDevSandboxReaper } from "../preview-worker/local/localDevSandboxReaper"
import { LocalArtifactHost } from "./artifactHost"

/**
 * Local, single-machine development launcher for the full preview path:
 * Preview API (backed by real PostgreSQL) + a durable worker loop running
 * the NOT-PRODUCTION-SAFE local adapters (see composeLocalDevWorker) +
 * a loopback-only static artifact host.
 *
 * Requests are authenticated with GitHub App OAuth. The server exchanges
 * the short-lived authorization code, verifies GET /user, and gives the
 * extension a short-lived Peephole session. PreviewSessionAuth verifies
 * that session for every preview request. What is NOT real here
 * is sandbox isolation: it must only ever be pointed at repositories you
 * already trust, on a developer machine. It is not a production
 * deployment of Peephole's preview
 * service.
 */

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url))
const ARTIFACT_STORAGE_DIR = path.join(os.tmpdir(), "peephole-dev-artifacts")

loadDotEnvFile(path.join(PROJECT_ROOT, ".env.local"))

async function main(): Promise<void> {
  const database = new PgPoolDatabase(readPostgresConfig(process.env).pool)
  await applyPostgresMigrations(database)

  const artifactHost = new LocalArtifactHost({
    storageDir: ARTIFACT_STORAGE_DIR,
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
    controlPlane: { runnerVersion: "local-dev-1" },
  })

  const sessionSigningSecret = readOrGenerateSessionSigningSecret()
  const sessionIssuer = new PreviewSessionIssuer(sessionSigningSecret)
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

  const worker = composeLocalDevWorker(composition.controlPlane, {
    artifactStorageDir: ARTIFACT_STORAGE_DIR,
  })
  const workerLoop = new PreviewWorkerLoop(composition.queue, worker, {
    workerId: `local-dev-${process.pid}`,
    onError: (error) => console.error("[peephole] worker loop error", error),
  })
  const workerController = new AbortController()
  const workerLoopDone = workerLoop.runUntilStopped(workerController.signal)
  const sandboxReaper = new LocalDevSandboxReaper()
  let maintenanceRunning: Promise<void> | undefined
  const maintain = () => {
    if (maintenanceRunning) return
    maintenanceRunning = Promise.all([
      sandboxReaper.reap(),
      artifactHost.reap(),
    ])
      .then(() => undefined)
      .catch(() => console.error("[peephole] cleanup failed; will retry"))
      .finally(() => {
        maintenanceRunning = undefined
      })
  }
  maintain()
  const maintenanceTimer = setInterval(maintain, 60_000)
  maintenanceTimer.unref()

  console.log(
    `[peephole] preview API listening on http://${api.address.address}:${api.address.port}`,
  )
  console.log(
    "[peephole] local worker running with NO sandbox isolation -- only build repositories you already trust.",
  )

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(maintenanceTimer)
    console.log(`[peephole] received ${signal}, shutting down...`)
    workerController.abort()
    await workerLoopDone.catch(() => undefined)
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
 * Falls back to a random, process-lifetime-only secret when
 * PEEPHOLE_SESSION_SIGNING_SECRET isn't set, so local development needs no
 * setup: sessions just stop verifying (forcing a silent, transparent
 * re-login) across a restart, which is the same effect the secret's own
 * absence-of-persistence is meant to have anyway. A real deployment should
 * set this explicitly so a restart doesn't sign every active user out.
 */
function readOrGenerateSessionSigningSecret(): string {
  const configured = process.env.PEEPHOLE_SESSION_SIGNING_SECRET

  if (configured) {
    return configured
  }

  console.log(
    "[peephole] PEEPHOLE_SESSION_SIGNING_SECRET not set; generated a random one for this process only.",
  )
  return randomBytes(32).toString("base64")
}

function loadDotEnvFile(filePath: string): void {
  if (!existsSync(filePath)) {
    return
  }

  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim()

    if (!trimmed || trimmed.startsWith("#")) {
      continue
    }

    const separatorIndex = trimmed.indexOf("=")

    if (separatorIndex === -1) {
      continue
    }

    const key = trimmed.slice(0, separatorIndex).trim()
    const value = trimmed
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^["']|["']$/g, "")

    if (key && process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

main().catch((error) => {
  console.error("[peephole] dev server failed to start", error)
  process.exit(1)
})
