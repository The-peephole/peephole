import type { FullStackPreviewStatus } from "../../types/fullstackPreview"
import type { PreviewJobStatus } from "../../types/preview"
import type { FullStackPreviewControlPlane } from "../fullstack-preview-api/controlPlane"
import type {
  FullStackPreviewQueue,
  FullStackPreviewStore,
  StoredFullStackPreview,
} from "../fullstack-preview-api/ports"
import type { PreviewControlPlane } from "../preview-api/controlPlane"
import { PreviewControlError } from "../preview-api/errors"

const ACTIVE_FRONTEND = new Set<PreviewJobStatus>([
  "queued",
  "fetching",
  "installing",
  "building",
  "publishing",
])
const STALE_AFTER_RESTART = new Set<FullStackPreviewStatus>([
  "building_frontend",
  "starting_backend",
  "awaiting_activation",
  "ready",
])

/** Reconciles durable parents after physical gVisor/network reapers have
 * completed and before any listener can authorize stale ready rows. */
export class FullStackPreviewStartupReconciler {
  constructor(
    private readonly store: FullStackPreviewStore,
    private readonly queue: FullStackPreviewQueue,
    private readonly fullStack: FullStackPreviewControlPlane,
    private readonly frontend: PreviewControlPlane,
  ) {}

  async reconcile(): Promise<void> {
    for (const preview of await this.store.listAll()) {
      if (preview.status === "queued") continue

      if (STALE_AFTER_RESTART.has(preview.status)) {
        await this.cancelFrontendIfActive(preview)
        await this.fullStack.failWorkerFullStackPreview(
          preview.id,
          "ORCHESTRATION_UNAVAILABLE",
        )
        await this.queue.cancel(preview.id)
        continue
      }

      if (preview.status === "stopping") {
        await this.cancelFrontendIfActive(preview)
        await this.fullStack.markPhase(preview.id, "stopped")
        await this.queue.cancel(preview.id)
        continue
      }

      // Terminal parents must never retain a reclaimable delivery after a
      // crash between parent terminalization and queue cleanup.
      await this.queue.cancel(preview.id)
    }
  }

  private async cancelFrontendIfActive(
    preview: StoredFullStackPreview,
  ): Promise<void> {
    if (!preview.frontendJobId) return
    try {
      const child = await this.frontend.getForOrchestration(
        preview.frontendJobId,
        preview.requesterId,
      )
      if (ACTIVE_FRONTEND.has(child.status)) {
        await this.frontend.cancelForOrchestration(
          preview.frontendJobId,
          preview.requesterId,
        )
      }
    } catch (error) {
      if (error instanceof PreviewControlError && error.code === "NOT_FOUND") {
        return
      }
      throw error
    }
  }
}
