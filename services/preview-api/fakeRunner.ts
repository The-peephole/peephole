import type { PreviewJobErrorCode, QueuedPreviewJob } from "../../types/preview"
import type { PreviewControlPlane } from "./controlPlane"

export interface FakePreviewJobSource {
  dequeue(): QueuedPreviewJob | null
}

export class FakePreviewRunner {
  constructor(
    private readonly source: FakePreviewJobSource,
    private readonly controlPlane: PreviewControlPlane,
  ) {}

  async runNext(
    result:
      | { status: "ready"; artifactId: string }
      | { status: "failed"; errorCode: PreviewJobErrorCode } = {
      status: "ready",
      artifactId: "fake-artifact",
    },
  ): Promise<string | null> {
    const queued = this.source.dequeue()

    if (!queued) {
      return null
    }

    await this.controlPlane.markPhase(queued.jobId, "fetching")

    if (result.status === "failed" && result.errorCode === "FETCH_FAILED") {
      await this.controlPlane.fail(queued.jobId, result.errorCode)
      return queued.jobId
    }

    if (queued.plan.installCommand) {
      await this.controlPlane.markPhase(queued.jobId, "installing")
    }

    if (result.status === "failed" && result.errorCode === "INSTALL_FAILED") {
      await this.controlPlane.fail(queued.jobId, result.errorCode)
      return queued.jobId
    }

    if (queued.plan.buildCommand) {
      await this.controlPlane.markPhase(queued.jobId, "building")
    }

    if (result.status === "failed") {
      await this.controlPlane.fail(queued.jobId, result.errorCode)
      return queued.jobId
    }

    await this.controlPlane.markPhase(queued.jobId, "publishing")
    await this.controlPlane.complete(queued.jobId, result.artifactId)
    return queued.jobId
  }
}
