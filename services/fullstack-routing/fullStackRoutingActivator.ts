import type { BackendRuntimeControlPlane } from "../backend-runtime-api/controlPlane"
import type { LiveBackendRuntimeRouteResolver } from "../backend-runtime-worker/liveRuntimeRegistry"
import type { FullStackPreviewControlPlane } from "../fullstack-preview-api/controlPlane"
import type { ProductionArtifactStore } from "../preview-api/postgres/productionArtifactStore"
import { validateProductionBaseDomain } from "../production/config"

export class FullStackRoutingActivationError extends Error {
  constructor(message = "Full-stack routing cannot be activated.") {
    super(message)
    this.name = "FullStackRoutingActivationError"
  }
}

export interface FullStackRoutingActivatorOptions {
  fullStackControlPlane: FullStackPreviewControlPlane
  artifactStore: Pick<ProductionArtifactStore, "get">
  backendControlPlane: BackendRuntimeControlPlane
  liveRuntimeResolver: LiveBackendRuntimeRouteResolver
  baseDomain: string
  now?: () => Date
}

/** Turns an already-provisioned parent into a ready origin only while every
 * durable and process-local authority agrees. */
export class FullStackRoutingActivator {
  private readonly baseDomain: string
  private readonly now: () => Date

  constructor(private readonly options: FullStackRoutingActivatorOptions) {
    this.baseDomain = validateProductionBaseDomain(options.baseDomain)
    this.now = options.now ?? (() => new Date())
  }

  async activate(previewId: string) {
    const parent =
      await this.options.fullStackControlPlane.getWorkerFullStackPreview(
        previewId,
      )
    if (
      !parent ||
      (parent.status !== "awaiting_activation" && parent.status !== "ready") ||
      !parent.frontendJobId ||
      !parent.artifactId ||
      !parent.backendRuntimeId
    ) {
      throw new FullStackRoutingActivationError()
    }

    const now = this.now().getTime()
    const artifact = await this.options.artifactStore.get(parent.artifactId)
    if (!artifact || artifact.expiresAt.getTime() <= now) {
      throw new FullStackRoutingActivationError()
    }

    let runtime
    try {
      runtime = await this.options.backendControlPlane.getForOrchestration(
        parent.backendRuntimeId,
        parent.requesterId,
      )
    } catch {
      throw new FullStackRoutingActivationError()
    }
    if (
      runtime.id !== parent.backendRuntimeId ||
      runtime.status !== "running" ||
      new Date(runtime.expiresAt).getTime() <= now
    ) {
      throw new FullStackRoutingActivationError()
    }

    try {
      if (!this.options.liveRuntimeResolver.resolve(parent.backendRuntimeId)) {
        throw new FullStackRoutingActivationError()
      }
    } catch {
      throw new FullStackRoutingActivationError()
    }

    const expiresAt = new Date(
      Math.min(
        new Date(parent.expiresAt).getTime(),
        artifact.expiresAt.getTime(),
        new Date(runtime.expiresAt).getTime(),
      ),
    )
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now) {
      throw new FullStackRoutingActivationError()
    }

    return this.options.fullStackControlPlane.activateRouting(parent.id, {
      expectedArtifactId: parent.artifactId,
      expectedBackendRuntimeId: parent.backendRuntimeId,
      url: `https://${parent.id}.${this.baseDomain}/`,
      expiresAt,
    })
  }
}
