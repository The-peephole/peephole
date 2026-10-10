import {
  InMemoryUserEnvironmentBroker,
  type UserEnvironmentBroker,
} from "../user-environment/userEnvironmentBroker"
import {
  TmpfsUserEnvironmentFilesystem,
  type TmpfsUserEnvironmentFilesystemOptions,
  type UserEnvironmentFilesystem,
} from "../preview-worker/gvisor/userEnvironmentFilesystem"
import {
  UserEnvironmentOrphanReaper,
  type UserEnvironmentOrphanReaperOptions,
} from "../preview-worker/gvisor/userEnvironmentOrphanReaper"
import type { UserEnvironmentProductionConfig } from "./config"
import { ensureUserEnvironmentCapability } from "./preflight"

export interface ProductionUserEnvironmentOrphanReaper {
  reap(): Promise<string[]>
  reapAll(): Promise<string[]>
}

export type ProductionUserEnvironmentRuntime =
  | { enabled: false }
  | {
      enabled: true
      broker: UserEnvironmentBroker
      filesystem: UserEnvironmentFilesystem
      orphanReaper: ProductionUserEnvironmentOrphanReaper
    }

export interface ProductionUserEnvironmentRuntimeOptions {
  config: UserEnvironmentProductionConfig
  baseRootfsImage: string
  /** Persistent, bundle, and other credential roots that must stay
   * disjoint from the user-env root. */
  forbiddenRoots: readonly string[]
  orphanReaperMaxAgeMs: number
}

interface ProductionUserEnvironmentRuntimeDependencies {
  ensureCapability?: typeof ensureUserEnvironmentCapability
  createFilesystem?: (
    options: TmpfsUserEnvironmentFilesystemOptions,
  ) => UserEnvironmentFilesystem
  createOrphanReaper?: (
    options: UserEnvironmentOrphanReaperOptions,
  ) => ProductionUserEnvironmentOrphanReaper
  createBroker?: () => UserEnvironmentBroker
}

/**
 * M12 production activation (default OFF). Startup always reaps leftover
 * user-env files under the configured root -- also while disabled, so a
 * rollback cleans what an earlier enabled process left. Only when enabled
 * does it prove the capability and return the one broker instance that
 * full-stack admission and the backend supervisor must share.
 */
export async function initializeProductionUserEnvironmentRuntime(
  options: ProductionUserEnvironmentRuntimeOptions,
  dependencies: ProductionUserEnvironmentRuntimeDependencies = {},
): Promise<ProductionUserEnvironmentRuntime> {
  const filesystem = (
    dependencies.createFilesystem ??
    ((filesystemOptions) =>
      new TmpfsUserEnvironmentFilesystem(filesystemOptions))
  )({
    rootDir: options.config.rootDir,
    forbiddenRoots: options.forbiddenRoots,
  })
  const orphanReaper = (
    dependencies.createOrphanReaper ??
    ((reaperOptions) => new UserEnvironmentOrphanReaper(reaperOptions))
  )({
    rootDir: options.config.rootDir,
    filesystem,
    maxAgeMs: options.orphanReaperMaxAgeMs,
  })

  if (!options.config.enabled) {
    await orphanReaper.reapAll()
    return { enabled: false }
  }

  await (dependencies.ensureCapability ?? ensureUserEnvironmentCapability)({
    rootDir: options.config.rootDir,
    baseRootfsImage: options.baseRootfsImage,
  })
  await orphanReaper.reapAll()
  return {
    enabled: true,
    broker:
      dependencies.createBroker?.() ?? new InMemoryUserEnvironmentBroker(),
    filesystem,
    orphanReaper,
  }
}
