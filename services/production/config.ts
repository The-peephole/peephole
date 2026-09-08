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
  /** ProductionArtifactHost's fixed listener port. Always bound to
   * 127.0.0.1 -- there is deliberately no host/bind-address setting here
   * (see services/production/artifactHost.ts), so this is the only thing
   * about that listener a deployment can configure. */
  artifactPort: number
  /** Internal TLS ask listener; bind address is always 127.0.0.1. */
  artifactTlsAskPort: number
  /** The wildcard domain a reverse proxy will eventually route
   * `<artifact-id>.<this>` to this listener under -- must stay a
   * different registrable domain from the trusted control-plane/UI
   * domain, since that separation is the entire point of routing preview
   * content through its own origin. */
  artifactBaseDomain: string
}

const DEFAULTS = {
  workerConcurrency: 1,
  baseRootfsImage: "/var/lib/peephole/base-rootfs",
  bundlesRootDir: "/var/lib/peephole/jobs",
  runscRootDir: "/var/run/peephole/runsc",
  artifactStorageDir: "/var/lib/peephole/artifacts",
  orphanReaperMaxAgeMs: 30 * 60_000,
  maintenanceIntervalMs: 60_000,
  artifactPort: 8_788,
  artifactTlsAskPort: 8_790,
  artifactBaseDomain: "peepholeusercontent.dev",
} as const

const TRUSTED_REGISTRABLE_DOMAIN = "peephole.dev"

export function readProductionConfig(
  environment: NodeJS.ProcessEnv,
): ProductionConfig {
  const config = {
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
    artifactPort: readInteger(
      "PEEPHOLE_ARTIFACT_PORT",
      environment.PEEPHOLE_ARTIFACT_PORT,
      DEFAULTS.artifactPort,
      1,
      65_535,
    ),
    artifactTlsAskPort: readInteger(
      "PEEPHOLE_ARTIFACT_TLS_ASK_PORT",
      environment.PEEPHOLE_ARTIFACT_TLS_ASK_PORT,
      DEFAULTS.artifactTlsAskPort,
      1,
      65_535,
    ),
    artifactBaseDomain: readDomain(
      "PEEPHOLE_ARTIFACT_BASE_DOMAIN",
      environment.PEEPHOLE_ARTIFACT_BASE_DOMAIN,
      DEFAULTS.artifactBaseDomain,
    ),
  }
  if (config.artifactTlsAskPort === config.artifactPort) {
    throw new Error(
      "PEEPHOLE_ARTIFACT_TLS_ASK_PORT must differ from PEEPHOLE_ARTIFACT_PORT.",
    )
  }
  return config
}

function readPath(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed || fallback
}

function readDomain(
  name: string,
  value: string | undefined,
  fallback: string,
): string {
  const trimmed = value?.trim().toLowerCase()

  if (!trimmed) {
    return fallback
  }

  if (
    trimmed.length > 253 ||
    trimmed === "localhost" ||
    !trimmed.includes(".") ||
    !/^[a-z\d]([a-z\d-]*[a-z\d])?(\.[a-z\d]([a-z\d-]*[a-z\d])?)+$/.test(trimmed)
  ) {
    throw new Error(`${name} must be a valid registrable domain name.`)
  }

  if (
    trimmed === TRUSTED_REGISTRABLE_DOMAIN ||
    trimmed.endsWith(`.${TRUSTED_REGISTRABLE_DOMAIN}`)
  ) {
    throw new Error(
      `${name} must not share the trusted ${TRUSTED_REGISTRABLE_DOMAIN} registrable domain.`,
    )
  }

  return trimmed
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
