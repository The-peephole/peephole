import type { PostgresDatabase } from "../../preview-api/postgres/database"
import {
  FullStackPreviewControlPlane,
  type FullStackPreviewControlPlaneOptions,
} from "../controlPlane"
import type { BackendPlanResolver, FrontendPlanResolver } from "../ports"
import type { PreviewQuota } from "../../preview-api/ports"
import { PostgresFullStackPreviewStore } from "./previewStore"
import { PostgresFullStackPreviewQueue } from "./queue"

export interface PostgresFullStackPreviewCompositionOptions {
  database: PostgresDatabase
  frontendPlanResolver: FrontendPlanResolver
  backendPlanResolver: BackendPlanResolver
  /** Public full-stack admission consumes the existing preview quota once;
   * the orchestration worker's static child path deliberately does not. */
  quota: PreviewQuota
  controlPlane?: FullStackPreviewControlPlaneOptions
}

export interface PostgresFullStackPreviewComposition {
  controlPlane: FullStackPreviewControlPlane
  store: PostgresFullStackPreviewStore
  queue: PostgresFullStackPreviewQueue
  isReady(): Promise<boolean>
}

/**
 * Mirrors `composePostgresControlPlane`
 * (services/preview-api/postgres/compose.ts) in spirit, kept as its own
 * function rather than folded into it: that function's signature is fixed
 * to the static `PreviewControlPlane`, and a `FullStackPreview` is its own
 * separate resource with its own store/queue, never a variant of the
 * static one. Production now composes both through the same database and
 * explicitly shared quota policy.
 */
export function composePostgresFullStackPreview(
  options: PostgresFullStackPreviewCompositionOptions,
): PostgresFullStackPreviewComposition {
  const queue = new PostgresFullStackPreviewQueue(options.database)
  const store = new PostgresFullStackPreviewStore(options.database)
  const controlPlane = new FullStackPreviewControlPlane(
    options.frontendPlanResolver,
    options.backendPlanResolver,
    store,
    queue,
    options.quota,
    options.controlPlane,
  )

  return {
    controlPlane,
    store,
    queue,
    isReady: () => options.database.ping(),
  }
}
