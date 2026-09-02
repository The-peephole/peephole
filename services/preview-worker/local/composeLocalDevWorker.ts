import { PreviewJobWorker } from "../worker"
import { ArchiveByteStore } from "./archiveByteStore"
import { CommandExecutionError, type CommandRunner } from "./commandRunner"
import { ExtractionState } from "./extractionState"
import { GitHubCommitArchiveFetcher } from "./githubCommitArchiveFetcher"
import { HostCommandRunner } from "./hostCommandRunner"
import { LocalArtifactPublisher } from "./localArtifactPublisher"
import { LocalDevSandboxProvisioner } from "./localDevSandboxProvisioner"
import { LocalOutputLocationRegistry } from "./localOutputLocationRegistry"
import { LocalOutputResolver } from "./localOutputResolver"
import { NpmBuildExecutor } from "./npmBuildExecutor"
import { NpmDependencyInstaller } from "./npmDependencyInstaller"
import type { PreviewControlPlane } from "../../preview-api/controlPlane"

export { CommandExecutionError }

/**
 * Wires every real (non-fake) Milestone 5 adapter together with
 * `LocalDevSandboxProvisioner`/`HostCommandRunner` standing in for gVisor.
 *
 * NOT PRODUCTION-SAFE: install and build commands run directly on this host
 * process with no sandbox, no resource limits, and no network restriction.
 * This exists to prove the fetch -> extract -> install -> build -> publish
 * pipeline end to end against real GitHub archives and real npm/vite runs.
 * Swap `LocalDevSandboxProvisioner`/`HostCommandRunner` for
 * `GVisorSandboxProvisioner`/`RunscCommandRunner` for any deployment that
 * builds untrusted, arbitrary repository content.
 */
export function composeLocalDevWorker(
  controlPlane: PreviewControlPlane,
  options: { commandRunner?: CommandRunner } = {},
): PreviewJobWorker {
  const byteStore = new ArchiveByteStore()
  const extraction = new ExtractionState()
  const locations = new LocalOutputLocationRegistry()
  const commandRunner = options.commandRunner ?? new HostCommandRunner()

  return new PreviewJobWorker(
    controlPlane,
    new GitHubCommitArchiveFetcher(byteStore),
    new LocalDevSandboxProvisioner(),
    new NpmDependencyInstaller(byteStore, extraction, commandRunner),
    new NpmBuildExecutor(commandRunner),
    new LocalOutputResolver(byteStore, extraction, locations),
    new LocalArtifactPublisher(locations),
  )
}
