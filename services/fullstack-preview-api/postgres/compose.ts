import type { PostgresDatabase } from "../../preview-api/postgres/database"
import {
  FullStackPreviewControlPlane,
  type FullStackPreviewControlPlaneOptions,
} from "../controlPlane"
import type { BackendPlanResolver, FrontendPlanResolver } from "../ports"
import { PostgresFullStackPreviewStore } from "./previewStore"
import { PostgresFullStackPreviewQueue } from "./queue"

export interface PostgresFullStackPreviewCompositionOptions {
  database: PostgresDatabase
  frontendPlanResolver: FrontendPlanResolver
  backendPlanResolver: BackendPlanResolver
  controlPlane?: FullStackPreviewControlPlaneOptions
}

export interface PostgresFullStackPreviewComposition {
  controlPlane: FullStackPreviewControlPlane
  queue: PostgresFullStackPreviewQueue
  isReady(): Promise<boolean>
}

/**
 * Mirrors `composePostgresControlPlane`
 * (services/preview-api/postgres/compose.ts) in spirit, kept as its own
 * function rather than folded into it: that function's signature is fixed
 * to the static `PreviewControlPlane`, and a `FullStackPreview` is its own
 * separate resource with its own store/queue, never a variant of the
 * static one. NOT called from services/production/server.ts yet -- see
 * this phase's PR description.
 */
export function composePostgresFullStackPreview(
  options: PostgresFullStackPreviewCompositionOptions,
): PostgresFullStackPreviewComposition {
  const queue = new PostgresFullStackPreviewQueue(options.database)
  const controlPlane = new FullStackPreviewControlPlane(
    options.frontendPlanResolver,
    options.backendPlanResolver,
    new PostgresFullStackPreviewStore(options.database),
    queue,
    options.controlPlane,
  )

  return {
    controlPlane,
    queue,
    isReady: () => options.database.ping(),
  }
}
