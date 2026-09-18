import type { BackendRuntimeControlPlane } from "../../backend-runtime-api/controlPlane"
import { BackendRuntimeSupervisor } from "../../backend-runtime-worker/backendRuntimeSupervisor"
import type { LiveBackendRuntimeRouteRegistry } from "../../backend-runtime-worker/liveRuntimeRegistry"
import { ArchiveByteStore } from "../local/archiveByteStore"
import { ExtractionState } from "../local/extractionState"
import { GitHubCommitArchiveFetcher } from "../local/githubCommitArchiveFetcher"
import type { resolveDnsConfig } from "./dnsConfig"
import { GVisorBackendRuntimeProcess } from "./backendRuntimeProcess"
import { GVisorSandboxProvisioner } from "./gvisorSandboxProvisioner"
import type { VethNatNetworkProvisioner } from "./networkNamespace"
import type { ProcessRunner } from "./processRunner"
import { RunscCommandRunner } from "./runscCommandRunner"
import type { SandboxDiskManager } from "./sandboxDisk"

export interface ComposeProductionBackendRuntimeOptions {
  /** Same trusted, read-only Node + npm rootfs tree the static pipeline
   * uses -- see composeProductionWorker.ts. */
  baseRootfsImage: string
  bundlesRootDir?: string
  runscBinaryPath?: string
  runscRootDir?: string
  processRunner?: ProcessRunner
  codeloadBaseUrl?: string
  networkProvisioner?: VethNatNetworkProvisioner
  resolveDnsConfig?: typeof resolveDnsConfig
  diskManager?: SandboxDiskManager
  installTimeoutMs?: number
  readinessTimeoutMs?: number
  /** Hard OS-process backstop, independent of and longer than the control
   * plane's own runtime TTL -- see GVisorBackendRuntimeProcess's doc
   * comment. */
  maxRuntimeMs?: number
  /** Process-local live-route registry the future same-process full-stack
   * proxy resolver will also read from -- REQUIRED, not defaulted, and
   * deliberately never constructed by this function. The one process
   * composing both the backend supervisor and (later) the proxy resolver
   * must own exactly one registry instance and pass the SAME instance to
   * both; a silently-constructed fallback here would let that composition
   * accidentally create two independent, disagreeing registries (the
   * supervisor registering routes nobody's resolver ever reads) with no
   * type or runtime error to catch it. */
  liveRuntimeRegistry: LiveBackendRuntimeRouteRegistry
}

/**
 * Wires the real, non-fake backend-v1 runtime pipeline: fetch -> install (via
 * the same `GVisorSandboxProvisioner` + `RunscCommandRunner` primitives the
 * static pipeline uses, `network: "sandbox"` for `npm ci`) -> start (via the
 * new `GVisorBackendRuntimeProcess`, an ingress-only network namespace, never
 * `network: "sandbox"`'s NAT'd egress) -> supervised until stopped.
 *
 * Deliberately NOT wired into `services/production/server.ts`'s `main()` in
 * this change -- see docs/PREVIEW_RUNTIME.md's "Known limitations". The
 * ingress-only network policy this depends on
 * (`VethNatNetworkProvisioner.createIngressOnly`,
 * `NetworkOrphanReaper`/`subnetAllocator.ts`'s `policy` field) has full unit
 * coverage but has not been exercised against a real gVisor/Linux host from
 * this change; production wiring should happen only after that verification.
 */
export function composeProductionBackendRuntime(
  controlPlane: BackendRuntimeControlPlane,
  options: ComposeProductionBackendRuntimeOptions,
): BackendRuntimeSupervisor {
  const byteStore = new ArchiveByteStore()
  const extraction = new ExtractionState()

  const sandbox = new GVisorSandboxProvisioner({
    baseRootfsImage: options.baseRootfsImage,
    bundlesRootDir: options.bundlesRootDir,
    runscBinaryPath: options.runscBinaryPath,
    runscRootDir: options.runscRootDir,
    processRunner: options.processRunner,
    networkProvisioner: options.networkProvisioner,
    diskManager: options.diskManager,
  })
  const installRunner = new RunscCommandRunner({
    network: "sandbox",
    runscBinaryPath: options.runscBinaryPath,
    runscRootDir: options.runscRootDir,
    processRunner: options.processRunner,
    resolveDnsConfig: options.resolveDnsConfig,
  })
  const runtimeProcessStarter = new GVisorBackendRuntimeProcess({
    runscBinaryPath: options.runscBinaryPath,
    runscRootDir: options.runscRootDir,
    processRunner: options.processRunner,
    resolveDnsConfig: options.resolveDnsConfig,
    maxRuntimeMs: options.maxRuntimeMs,
  })

  return new BackendRuntimeSupervisor(
    controlPlane,
    new GitHubCommitArchiveFetcher(byteStore, {
      codeloadBaseUrl: options.codeloadBaseUrl,
    }),
    byteStore,
    extraction,
    sandbox,
    installRunner,
    runtimeProcessStarter,
    options.liveRuntimeRegistry,
    {
      installTimeoutMs: options.installTimeoutMs,
      readinessTimeoutMs: options.readinessTimeoutMs,
      cleanup: (runtimeId) => {
        extraction.delete(runtimeId)
      },
    },
  )
}
