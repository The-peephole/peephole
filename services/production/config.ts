export interface ProductionConfig {
  /** How many jobs this host runs at once -- each PreviewWorkerLoop
   * instance leases and runs jobs one at a time, so N loops means N
   * concurrent gVisor sandboxes. Defaults to 1: the current AWS EC2
   * deployment target is 2 vCPU / 2GB RAM, which a single CPU/memory-quota'd
   * sandbox (see core/runner/runnerLimits.ts) can already consume most of
   * on its own. */
  workerConcurrency: number
  baseRootfsImage: string
  bundlesRootDir: string
  runscRootDir: string
  artifactStorageDir: string
  orphanReaperMaxAgeMs: number
  maintenanceIntervalMs: number
}

const DEFAULTS = {
  workerConcurrency: 1,
  baseRootfsImage: "/var/lib/peephole/base-rootfs",
  bundlesRootDir: "/var/lib/peephole/jobs",
  runscRootDir: "/var/run/peephole/runsc",
  artifactStorageDir: "/var/lib/peephole/artifacts",
  orphanReaperMaxAgeMs: 30 * 60_000,
  maintenanceIntervalMs: 60_000,
} as const

export function readProductionConfig(
  environment: NodeJS.ProcessEnv,
): ProductionConfig {
  return {
    workerConcurrency: readInteger(
      "PEEPHOLE_WORKER_CONCURRENCY",
      environment.PEEPHOLE_WORKER_CONCURRENCY,
      DEFAULTS.workerConcurrency,
      1,
      16,
    ),
    baseRootfsImage: readPath(
      environment.PEEPHOLE_GVISOR_BASE_ROOTFS,
      DEFAULTS.baseRootfsImage,
    ),
    bundlesRootDir: readPath(
      environment.PEEPHOLE_GVISOR_BUNDLES_DIR,
      DEFAULTS.bundlesRootDir,
    ),
    runscRootDir: readPath(
      environment.PEEPHOLE_GVISOR_RUNSC_ROOT,
      DEFAULTS.runscRootDir,
    ),
    artifactStorageDir: readPath(
      environment.PEEPHOLE_ARTIFACT_STORAGE_DIR,
      DEFAULTS.artifactStorageDir,
    ),
    orphanReaperMaxAgeMs: readInteger(
      "PEEPHOLE_GVISOR_ORPHAN_MAX_AGE_MS",
      environment.PEEPHOLE_GVISOR_ORPHAN_MAX_AGE_MS,
      DEFAULTS.orphanReaperMaxAgeMs,
      60_000,
      24 * 60 * 60_000,
    ),
    maintenanceIntervalMs: readInteger(
      "PEEPHOLE_MAINTENANCE_INTERVAL_MS",
      environment.PEEPHOLE_MAINTENANCE_INTERVAL_MS,
      DEFAULTS.maintenanceIntervalMs,
      5_000,
      10 * 60_000,
    ),
  }
}

function readPath(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed || fallback
}

function readInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback
  }

  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${name} must be an integer.`)
  }

  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`)
  }

  return parsed
}
