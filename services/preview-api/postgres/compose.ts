import type { PreviewArtifactSigner, PreviewPlanResolver } from "../ports"
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
}

export interface PostgresControlPlaneComposition {
  controlPlane: PreviewControlPlane
  queue: PostgresPreviewQueue
  isReady(): Promise<boolean>
}

export function composePostgresControlPlane(
  options: PostgresControlPlaneCompositionOptions,
): PostgresControlPlaneComposition {
  const queue = new PostgresPreviewQueue(options.database)
  const controlPlane = new PreviewControlPlane(
    options.planResolver,
    new PostgresPreviewJobStore(options.database),
    queue,
    new PostgresPreviewArtifactCache(options.database),
    options.artifactSigner,
    new PostgresPreviewQuota(options.database, options.quota),
    options.controlPlane,
  )

  return {
    controlPlane,
    queue,
    isReady: () => options.database.ping(),
  }
}
