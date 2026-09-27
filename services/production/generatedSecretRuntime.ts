import path from "node:path"

import type { BackendRuntimeSecretBroker } from "../backend-runtime-worker/secretBroker"
import { InMemoryBackendRuntimeSecretBroker } from "../backend-runtime-worker/secretBroker"
import {
  TmpfsGeneratedSecretFilesystem,
  type GeneratedSecretFilesystem,
  type TmpfsGeneratedSecretFilesystemOptions,
} from "../preview-worker/gvisor/generatedSecretFilesystem"
import {
  GeneratedSecretOrphanReaper,
  type GeneratedSecretOrphanReaperOptions,
} from "../preview-worker/gvisor/generatedSecretOrphanReaper"
import { ensureGeneratedSecretInjectionCapability } from "./preflight"

export interface ProductionGeneratedSecretRuntimeOptions {
  secretRootDir: string
  baseRootfsImage: string
  bundlesRootDir: string
  artifactStorageDir: string
  orphanReaperMaxAgeMs: number
}

export interface ProductionGeneratedSecretOrphanReaper {
  reap(): Promise<string[]>
  reapAll(): Promise<string[]>
}

export interface ProductionGeneratedSecretRuntime {
  secretBroker: BackendRuntimeSecretBroker
  filesystem: GeneratedSecretFilesystem
  orphanReaper: ProductionGeneratedSecretOrphanReaper
}

interface ProductionGeneratedSecretRuntimeDependencies {
  ensureCapability?: (options: {
    secretRootDir: string
    baseRootfsImage: string
  }) => Promise<void>
  createFilesystem?: (
    options: TmpfsGeneratedSecretFilesystemOptions,
  ) => GeneratedSecretFilesystem
  createOrphanReaper?: (
    options: GeneratedSecretOrphanReaperOptions,
  ) => ProductionGeneratedSecretOrphanReaper
  createBroker?: () => BackendRuntimeSecretBroker
}

/**
 * Establishes the production generated-secret capability before any worker or
 * listener exists. Construction itself generates no values: the broker stays
 * empty until a non-empty validated runtime reaches the supervisor's START
 * boundary.
 */
export async function initializeProductionGeneratedSecretRuntime(
  options: ProductionGeneratedSecretRuntimeOptions,
  dependencies: ProductionGeneratedSecretRuntimeDependencies = {},
): Promise<ProductionGeneratedSecretRuntime> {
  const createFilesystem =
    dependencies.createFilesystem ??
    ((filesystemOptions) =>
      new TmpfsGeneratedSecretFilesystem(filesystemOptions))
  const filesystem = createFilesystem({
    rootDir: options.secretRootDir,
    forbiddenRoots: [options.bundlesRootDir, options.artifactStorageDir],
  })
  if (
    path.resolve(filesystem.rootDir) !== path.resolve(options.secretRootDir)
  ) {
    throw new Error("Generated-secret runtime and filesystem roots must match.")
  }

  const createOrphanReaper =
    dependencies.createOrphanReaper ??
    ((reaperOptions) => new GeneratedSecretOrphanReaper(reaperOptions))
  const orphanReaper = createOrphanReaper({
    rootDir: options.secretRootDir,
    filesystem,
    maxAgeMs: options.orphanReaperMaxAgeMs,
  })

  await (
    dependencies.ensureCapability ?? ensureGeneratedSecretInjectionCapability
  )({
    secretRootDir: options.secretRootDir,
    baseRootfsImage: options.baseRootfsImage,
  })
  await orphanReaper.reapAll()

  return {
    secretBroker:
      dependencies.createBroker?.() ?? new InMemoryBackendRuntimeSecretBroker(),
    filesystem,
    orphanReaper,
  }
}
