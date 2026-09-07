import { existsSync, readFileSync } from "node:fs"
import type { IncomingMessage } from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { GitHubClient } from "../../core/github/client"
import { KnownRepositoryFilesLoader } from "../../core/github/knownFiles"
import type { PreviewRequester } from "../../types/preview"
import { GitHubPreviewPlanResolver } from "../preview-api/githubPlanResolver"
import { PgPoolDatabase } from "../preview-api/postgres/database"
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
 * Local, single-user development launcher for the full preview path:
 * Preview API (backed by real PostgreSQL) + a durable worker loop running
 * the NOT-PRODUCTION-SAFE local adapters (see composeLocalDevWorker) +
 * a loopback-only static artifact host.
 *
 * This intentionally has no authentication and no sandbox isolation. It
 * must only ever be pointed at repositories you already trust, on a
 * developer machine. It is not a deployment of Peephole's preview service.
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

  const apiConfig = readPreviewApiServerConfig(process.env)
  const api = await startNodePreviewApi({
    controlPlane: composition.controlPlane,
    config: apiConfig,
    resolveRequester,
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

function resolveRequester(request: IncomingMessage): PreviewRequester {
  return {
    subject: "local-dev-user",
    ip: request.socket.remoteAddress ?? "127.0.0.1",
  }
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
