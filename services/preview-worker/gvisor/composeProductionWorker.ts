import { PreviewJobWorker } from "../worker"
import { ArchiveByteStore } from "../local/archiveByteStore"
import { CommandExecutionError } from "../local/commandRunner"
import { ExtractionState } from "../local/extractionState"
import { GitHubCommitArchiveFetcher } from "../local/githubCommitArchiveFetcher"
import { LocalArtifactPublisher } from "../local/localArtifactPublisher"
import { LocalOutputLocationRegistry } from "../local/localOutputLocationRegistry"
import { LocalOutputResolver } from "../local/localOutputResolver"
import { NpmBuildExecutor } from "../local/npmBuildExecutor"
import { NpmDependencyInstaller } from "../local/npmDependencyInstaller"
import type { PreviewControlPlane } from "../../preview-api/controlPlane"
import { GVisorSandboxProvisioner } from "./gvisorSandboxProvisioner"
import type { resolveDnsConfig } from "./dnsConfig"
import type { VethNatNetworkProvisioner } from "./networkNamespace"
import type { ProcessRunner } from "./processRunner"
import { RunscCommandRunner } from "./runscCommandRunner"
import type { SandboxDiskManager } from "./sandboxDisk"

export { CommandExecutionError }

export interface ComposeProductionWorkerOptions {
  /** A prepared, read-only Node + npm rootfs tree -- see
   * scripts/gvisor/build-base-rootfs.sh. Production must always point this
   * at /var/lib/peephole/base-rootfs (services/production/config.ts's
   * default); it is only a parameter here so tests can point it at a small
   * fixture instead. */
  baseRootfsImage: string
  bundlesRootDir?: string
  runscBinaryPath?: string
  runscRootDir?: string
  artifactStorageDir?: string
  /** Overridable for tests; defaults to real runsc process spawning. */
  processRunner?: ProcessRunner
  /** Overridable for tests; defaults to GitHub's real codeload host. */
  codeloadBaseUrl?: string
  /** Overridable for tests, so a fake run doesn't reach for
   * SubnetAllocator's real default lease directory
   * (/var/run/peephole/net-leases). */
  networkProvisioner?: VethNatNetworkProvisioner
  /** Test seam for the exact resolver source and firewall exceptions. */
  resolveDnsConfig?: typeof resolveDnsConfig
  /** Shared with startup/maintenance reconciliation in production so disk
   * lifecycle ownership cannot diverge between allocators and reapers. */
  diskManager?: SandboxDiskManager
}

/**
 * Wires the real, non-fake preview pipeline for a deployment that builds
 * untrusted, arbitrary repository content: `GVisorSandboxProvisioner` +
 * `RunscCommandRunner` in place of `composeLocalDevWorker`'s
 * `LocalDevSandboxProvisioner`/`HostCommandRunner` (see that function's own
 * doc comment for exactly why those are unsafe outside development).
 *
 * Install gets real network egress (`network: "sandbox"`, needed for `npm
 * ci` and esbuild's postinstall binary fetch); the build step never touches
 * the network and runs with `network: "none"` -- the same split already
 * verified end to end against a real gVisor host, with real network
 * egress, in tests/realGvisorGoldenPath.test.ts. Every `RunscCommandRunner`
 * here shares one `runscBinaryPath`/`runscRootDir` with the sandbox
 * provisioner; nothing in this composition ever requests `network: "host"`
 * (runscCli.ts's diagnostic-only escape hatch), so production egress is
 * always through the real, NAT'd sandbox network namespace.
 */
export function composeProductionWorker(
  controlPlane: PreviewControlPlane,
  options: ComposeProductionWorkerOptions,
): PreviewJobWorker {
  const byteStore = new ArchiveByteStore()
  const extraction = new ExtractionState()
  const locations = new LocalOutputLocationRegistry()

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
  const buildRunner = new RunscCommandRunner({
    network: "none",
    runscBinaryPath: options.runscBinaryPath,
    runscRootDir: options.runscRootDir,
    processRunner: options.processRunner,
    resolveDnsConfig: options.resolveDnsConfig,
  })

  return new PreviewJobWorker(
    controlPlane,
    new GitHubCommitArchiveFetcher(byteStore, {
      codeloadBaseUrl: options.codeloadBaseUrl,
    }),
    sandbox,
    new NpmDependencyInstaller(byteStore, extraction, installRunner),
    new NpmBuildExecutor(buildRunner),
    new LocalOutputResolver(byteStore, extraction, locations),
    new LocalArtifactPublisher(locations, {
      storageDir: options.artifactStorageDir,
    }),
    {
      cleanup: (job) => {
        byteStore.delete(job.repository.commitSha)
        extraction.delete(job.jobId)
        locations.delete(job.jobId)
      },
    },
  )
}
