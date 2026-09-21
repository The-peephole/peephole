import type { BackendRuntimeControlPlane } from "../backend-runtime-api/controlPlane"
import { LiveBackendRuntimeRegistry } from "../backend-runtime-worker/liveRuntimeRegistry"
import type { FullStackPreviewControlPlane } from "../fullstack-preview-api/controlPlane"
import { BoundedBackendProxy } from "../fullstack-routing/backendProxy"
import { FullStackRoutingActivator } from "../fullstack-routing/fullStackRoutingActivator"
import { PostgresFullStackRoutingStore } from "../fullstack-routing/postgresFullStackRoutingStore"
import type { PostgresDatabase } from "../preview-api/postgres/database"
import type { ProductionArtifactStore } from "../preview-api/postgres/productionArtifactStore"
import { ProductionArtifactHost } from "./artifactHost"
import { ProductionArtifactTlsAskServer } from "./artifactTlsAskServer"

export interface ProductionFullStackRoutingInfrastructureOptions {
  database: PostgresDatabase
  artifactStore: ProductionArtifactStore
  artifactStorageDir: string
  artifactPort: number
  artifactTlsAskPort: number
  artifactBaseDomain: string
  trustedAppOrigin: string
}

/** Owns the single process-local registry shared by every production routing
 * participant. Construction is side-effect free; listeners start only after
 * startup reconciliation succeeds. */
export function createProductionFullStackRoutingInfrastructure(
  options: ProductionFullStackRoutingInfrastructureOptions,
) {
  const liveRuntimeRegistry = new LiveBackendRuntimeRegistry()
  const routingStore = new PostgresFullStackRoutingStore(options.database)
  const backendProxy = new BoundedBackendProxy({
    trustedAppOrigin: options.trustedAppOrigin,
  })
  const artifactHost = new ProductionArtifactHost({
    storageDir: options.artifactStorageDir,
    store: options.artifactStore,
    port: options.artifactPort,
    trustedAppOrigin: options.trustedAppOrigin,
    baseDomain: options.artifactBaseDomain,
    fullStackRouting: {
      store: routingStore,
      liveRuntimeResolver: liveRuntimeRegistry,
      backendProxy,
    },
  })
  const tlsAskServer = new ProductionArtifactTlsAskServer({
    store: options.artifactStore,
    port: options.artifactTlsAskPort,
    baseDomain: options.artifactBaseDomain,
    fullStackRouting: { store: routingStore },
  })

  return {
    liveRuntimeRegistry,
    routingStore,
    backendProxy,
    artifactHost,
    tlsAskServer,
    createActivator(
      fullStackControlPlane: FullStackPreviewControlPlane,
      backendControlPlane: BackendRuntimeControlPlane,
    ) {
      return new FullStackRoutingActivator({
        fullStackControlPlane,
        artifactStore: options.artifactStore,
        backendControlPlane,
        liveRuntimeResolver: liveRuntimeRegistry,
        baseDomain: options.artifactBaseDomain,
      })
    },
  }
}
