import type {
  PreviewArtifactSigner,
  PreviewPlanResolver,
  PreviewQuota,
} from "../ports"
import {
  PreviewControlPlane,
  type PreviewControlPlaneOptions,
} from "../controlPlane"
import { PostgresPreviewArtifactCache } from "./artifactCache"
import type { PostgresDatabase } from "./database"
import { PostgresPreviewJobStore } from "./jobStore"
import { PostgresPreviewQueue } from "./queue"
import { PostgresPreviewQuota, type PostgresPreviewQuotaOptions } from "./quota"

export interface PostgresControlPlaneCompositionOptions {
  database: PostgresDatabase
  planResolver: PreviewPlanResolver
  artifactSigner: PreviewArtifactSigner
  controlPlane: PreviewControlPlaneOptions
  quota?: PostgresPreviewQuotaOptions
  /** Allows related production APIs to share one explicitly configured quota
   * policy backed by the same durable scope table. */
  quotaProvider?: PreviewQuota
}

export interface PostgresControlPlaneComposition {
  controlPlane: PreviewControlPlane
  queue: PostgresPreviewQueue
  artifacts: PostgresPreviewArtifactCache
  isReady(): Promise<boolean>
}

export function composePostgresControlPlane(
  options: PostgresControlPlaneCompositionOptions,
): PostgresControlPlaneComposition {
  const queue = new PostgresPreviewQueue(options.database)
  const artifacts = new PostgresPreviewArtifactCache(options.database)
  const controlPlane = new PreviewControlPlane(
    options.planResolver,
    new PostgresPreviewJobStore(options.database),
    queue,
    artifacts,
    options.artifactSigner,
    options.quotaProvider ??
      new PostgresPreviewQuota(options.database, options.quota),
    options.controlPlane,
  )

  return {
    controlPlane,
    queue,
    artifacts,
    isReady: () => options.database.ping(),
  }
}
