import path from "node:path"

import { TENANT_DATABASE_PORT } from "../../core/backendDatabase/databaseUrl"
import { validateTrustedAppOrigin } from "./trustedOrigin"
import {
  DEFAULT_HOST_DISK_RESERVE_BYTES,
  DEFAULT_SANDBOX_DISK_LIMIT_BYTES,
  MAX_SANDBOX_DISK_LIMIT_BYTES,
  MIN_SANDBOX_DISK_LIMIT_BYTES,
} from "../preview-worker/gvisor/sandboxDisk"

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
  /** Dedicated memory-backed host root reserved for generated-secret
   * material. M10-B defines it but does not enable broker/supervisor wiring. */
  generatedSecretRootDir: string
  artifactStorageDir: string
  orphanReaperMaxAgeMs: number
  maintenanceIntervalMs: number
  /** Proposed defaults are 1 GiB and 2 GiB. Operators must validate them
   * against the production EC2 volume before treating them as final. */
  sandboxDiskBytes: number
  hostDiskReserveBytes: number
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
  /** Operator-supplied site root; no public suffix inference is performed. */
  trustedRegistrableDomain: string
  trustedAppOrigin: string
  /** M11 temporary PostgreSQL previews. Default OFF; see
   * docs/TEMPORARY_DATABASES.md section 17 for the activation gate. */
  temporaryDatabases: TemporaryDatabaseProductionConfig
  /** M12 user-provided preview configuration. Default OFF; the root is
   * known in both modes so a rollback still clears leftover files. */
  userEnvironment: UserEnvironmentProductionConfig
}

export interface UserEnvironmentProductionConfig {
  enabled: boolean
  rootDir: string
}

/** The database-credential root is known in both modes: a rollback that
 * disables temporary databases must still clean credential files an earlier
 * enabled process left under the same (possibly non-default) root. */
export type TemporaryDatabaseProductionConfig =
  | { enabled: false; credentialRootDir: string }
  | {
      enabled: true
      /** Server/operator-only tenant provisioning credential. Never logged,
       * echoed in errors, persisted, or passed to a sandbox. */
      provisioningUrl: string
      credentialRootDir: string
    }

const DEFAULTS = {
  workerConcurrency: 1,
  baseRootfsImage: "/var/lib/peephole/base-rootfs",
  bundlesRootDir: "/var/lib/peephole/jobs",
  runscRootDir: "/var/run/peephole/runsc",
  generatedSecretRootDir: "/run/peephole/secrets",
  artifactStorageDir: "/var/lib/peephole/artifacts",
  orphanReaperMaxAgeMs: 30 * 60_000,
  maintenanceIntervalMs: 60_000,
  sandboxDiskBytes: DEFAULT_SANDBOX_DISK_LIMIT_BYTES,
  hostDiskReserveBytes: DEFAULT_HOST_DISK_RESERVE_BYTES,
  artifactPort: 8_788,
  artifactTlsAskPort: 8_790,
  artifactBaseDomain: "peepholeusercontent.dev",
  trustedRegistrableDomain: "peephole.dev",
  trustedAppOrigin: "https://app.peephole.dev",
  databaseCredentialRootDir: "/run/peephole/db-credentials",
  userEnvironmentRootDir: "/run/peephole/user-env",
} as const

export function readProductionConfig(
  environment: NodeJS.ProcessEnv,
): ProductionConfig {
  const trustedRegistrableDomain = readDomain(
    "PEEPHOLE_TRUSTED_REGISTRABLE_DOMAIN",
    environment.PEEPHOLE_TRUSTED_REGISTRABLE_DOMAIN,
    DEFAULTS.trustedRegistrableDomain,
  )
  const config = {
    trustedRegistrableDomain,
    trustedAppOrigin: validateTrustedAppOrigin(
      environment.PEEPHOLE_TRUSTED_APP_ORIGIN ?? DEFAULTS.trustedAppOrigin,
      trustedRegistrableDomain,
    ),
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
    generatedSecretRootDir: readAbsolutePath(
      "PEEPHOLE_GENERATED_SECRET_ROOT",
      environment.PEEPHOLE_GENERATED_SECRET_ROOT,
      DEFAULTS.generatedSecretRootDir,
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
    sandboxDiskBytes: readInteger(
      "PEEPHOLE_SANDBOX_DISK_BYTES",
      environment.PEEPHOLE_SANDBOX_DISK_BYTES,
      DEFAULTS.sandboxDiskBytes,
      MIN_SANDBOX_DISK_LIMIT_BYTES,
      MAX_SANDBOX_DISK_LIMIT_BYTES,
    ),
    hostDiskReserveBytes: readInteger(
      "PEEPHOLE_HOST_DISK_RESERVE_BYTES",
      environment.PEEPHOLE_HOST_DISK_RESERVE_BYTES,
      DEFAULTS.hostDiskReserveBytes,
      0,
      Number.MAX_SAFE_INTEGER,
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
    temporaryDatabases: readTemporaryDatabaseConfig(environment),
    userEnvironment: readUserEnvironmentConfig(environment),
  }
  // Compare at label boundaries in both directions, including equality.
  if (
    config.artifactBaseDomain === trustedRegistrableDomain ||
    config.artifactBaseDomain.endsWith(`.${trustedRegistrableDomain}`) ||
    trustedRegistrableDomain.endsWith(`.${config.artifactBaseDomain}`)
  ) {
    throw new Error(
      `PEEPHOLE_ARTIFACT_BASE_DOMAIN must not share the trusted ${trustedRegistrableDomain} registrable domain.`,
    )
  }
  if (config.artifactTlsAskPort === config.artifactPort) {
    throw new Error(
      "PEEPHOLE_ARTIFACT_TLS_ASK_PORT must differ from PEEPHOLE_ARTIFACT_PORT.",
    )
  }
  return config
}

/** Only the exact value "1" enables M12; unset, empty, or "0" disables it,
 * and anything else is a configuration error rather than a guess. */
function readUserEnvironmentConfig(
  environment: NodeJS.ProcessEnv,
): UserEnvironmentProductionConfig {
  const flag = environment.PEEPHOLE_USER_ENVIRONMENT?.trim() ?? ""
  if (flag !== "" && flag !== "0" && flag !== "1") {
    throw new Error("PEEPHOLE_USER_ENVIRONMENT must be 0 or 1.")
  }
  return {
    enabled: flag === "1",
    rootDir: readAbsolutePath(
      "PEEPHOLE_USER_ENVIRONMENT_ROOT",
      environment.PEEPHOLE_USER_ENVIRONMENT_ROOT,
      DEFAULTS.userEnvironmentRootDir,
    ),
  }
}

/** Only the exact value "1" enables M11; unset, empty, or "0" disables it,
 * and anything else is a configuration error rather than a guess. The
 * credential root is read in both modes; the provisioning URL is read and
 * required only while enabled. */
function readTemporaryDatabaseConfig(
  environment: NodeJS.ProcessEnv,
): TemporaryDatabaseProductionConfig {
  const flag = environment.PEEPHOLE_TEMPORARY_DATABASES?.trim() ?? ""
  if (flag !== "" && flag !== "0" && flag !== "1") {
    throw new Error("PEEPHOLE_TEMPORARY_DATABASES must be 0 or 1.")
  }
  const credentialRootDir = readAbsolutePath(
    "PEEPHOLE_DATABASE_CREDENTIAL_ROOT",
    environment.PEEPHOLE_DATABASE_CREDENTIAL_ROOT,
    DEFAULTS.databaseCredentialRootDir,
  )
  if (flag !== "1") return { enabled: false, credentialRootDir }

  const provisioningUrl = environment.PEEPHOLE_TENANT_DB_PROVISIONING_URL
  // Messages below deliberately never include the configured value.
  if (!provisioningUrl || !isProvisioningUrl(provisioningUrl)) {
    throw new Error(
      `PEEPHOLE_TENANT_DB_PROVISIONING_URL must be a Unix-socket PostgreSQL URL of the form postgresql://<user>:<password>@%2F<socket-dir>:${String(TENANT_DATABASE_PORT)}/<database> with no query string when PEEPHOLE_TEMPORARY_DATABASES=1.`,
    )
  }
  if (provisioningUrl === environment.PEEPHOLE_DATABASE_URL) {
    throw new Error(
      "PEEPHOLE_TENANT_DB_PROVISIONING_URL must not reuse the control-plane PEEPHOLE_DATABASE_URL.",
    )
  }

  return { enabled: true, provisioningUrl, credentialRootDir }
}

/**
 * The provisioning connection must use the tenant cluster's local Unix-domain
 * socket, never the sandbox-facing TCP listener or any network host
 * (docs/TEMPORARY_DATABASES.md section 8). The one accepted form is the one
 * node-postgres resolves to a socket directory: a percent-encoded absolute
 * path as the URL host (`%2Frun%2Fpostgresql`), with the locked tenant port
 * naming the socket file. Query strings are refused outright because
 * node-postgres lets `?host=`/`?port=`/`?user=` override the URL itself.
 */
function isProvisioningUrl(value: string): boolean {
  // Even an empty `?` or `#` is refused, so exactly one form is accepted.
  if (value.includes("?") || value.includes("#")) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (
    (url.protocol !== "postgresql:" && url.protocol !== "postgres:") ||
    url.username === "" ||
    url.password === "" ||
    url.pathname.length <= 1 ||
    url.pathname.slice(1).includes("/") ||
    url.search !== "" ||
    url.hash !== "" ||
    url.port !== String(TENANT_DATABASE_PORT) ||
    !/^%2f/i.test(url.hostname)
  ) {
    return false
  }
  let socketDirectory: string
  try {
    socketDirectory = decodeURIComponent(url.hostname)
  } catch {
    return false
  }
  return (
    socketDirectory.length > 1 &&
    path.posix.normalize(socketDirectory) === socketDirectory &&
    !socketDirectory.endsWith("/")
  )
}

function readPath(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed || fallback
}

function readAbsolutePath(
  name: string,
  value: string | undefined,
  fallback: string,
): string {
  const candidate = readPath(value, fallback)
  if (!candidate.startsWith("/")) {
    throw new Error(`${name} must be an absolute path.`)
  }
  return candidate
}

function readDomain(
  name: string,
  value: string | undefined,
  fallback: string,
): string {
  const trimmed = (value ?? fallback).trim().toLowerCase()

  if (
    trimmed.length > 253 ||
    trimmed === "localhost" ||
    trimmed.endsWith(".localhost") ||
    trimmed.split(".").some((label) => label.length > 63) ||
    /^[\d.]+$/.test(trimmed) ||
    !trimmed.includes(".") ||
    !/^[a-z\d]([a-z\d-]*[a-z\d])?(\.[a-z\d]([a-z\d-]*[a-z\d])?)+$/.test(trimmed)
  ) {
    throw new Error(`${name} must be a valid registrable domain name.`)
  }

  return trimmed
}

/** Reuses the production configuration's exact domain grammar for trusted
 * internal components that generate public preview origins. */
export function validateProductionBaseDomain(value: string): string {
  return readDomain("baseDomain", value, value)
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
