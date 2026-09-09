import { randomBytes } from "node:crypto"
import { chmod, chown, cp, mkdir, rm } from "node:fs/promises"
import path from "node:path"

import { DEFAULT_RUNNER_TIMEOUTS } from "../../../core/runner/runnerLimits"
import type { SandboxProvisioner } from "../ports"
import type { GVisorPreviewWorkspace } from "./gvisorWorkspace"
import type { NetworkNamespaceHandle } from "./networkNamespace"
import { VethNatNetworkProvisioner } from "./networkNamespace"
import { NodeProcessRunner } from "./nodeProcessRunner"
import type { ProcessRunner } from "./processRunner"
import { runscDeleteArgs, runscKillArgs } from "./runscCli"
import { SANDBOX_GID, SANDBOX_HOME, SANDBOX_UID } from "./sandboxIdentity"

export interface GVisorSandboxProvisionerOptions {
  runscBinaryPath?: string
  runscRootDir?: string
  bundlesRootDir?: string
  /**
   * A prepared, read-only Node 24 + npm rootfs tree (no secrets, no host
   * config) copied fresh into every job's bundle. Building and maintaining
   * this image is a release blocker tracked separately from this adapter.
   */
  baseRootfsImage: string
  jobTimeoutMs?: number
  processRunner?: ProcessRunner
  networkProvisioner?: VethNatNetworkProvisioner
  now?: () => Date
}

/**
 * Prepares a fresh OCI bundle per job by copying the base rootfs image; the
 * actual `runsc run` invocation happens per-command in `RunscCommandRunner`.
 * `destroy()` sweeps every container this workspace ever started (defense
 * against a job cancelled mid-command) before removing the bundle
 * directory, and is idempotent.
 *
 * Verified against a real gVisor host (runsc, WSL2 Ubuntu): non-root
 * execution, writes persisting to disk across containers, and PID-limit
 * enforcement all confirmed real (see tests/realGvisorSandbox.test.ts).
 *
 * Network egress: a bare `runsc run --network=sandbox` never brings the
 * sandbox's interface up on its own (ENETUNREACH even for a raw TCP
 * connect) -- unlike `runsc do`, which performs its own veth/IP/NAT setup
 * that would normally come from a CNI plugin under a full container
 * platform. `ensureNetworkNamespace()` (lazy, memoized per workspace)
 * replicates that setup via `VethNatNetworkProvisioner`, giving each job
 * its own non-conflicting subnet; `RunscCommandRunner` calls it and joins
 * the resulting namespace when constructed with `network: "sandbox"`.
 * See that provisioner's doc comment for what it does and does not
 * restrict.
 */
export class GVisorSandboxProvisioner implements SandboxProvisioner {
  private readonly runscBinaryPath: string
  private readonly runscRootDir: string
  private readonly bundlesRootDir: string
  private readonly jobTimeoutMs: number
  private readonly processRunner: ProcessRunner
  private readonly networkProvisioner: VethNatNetworkProvisioner
  private readonly now: () => Date

  constructor(private readonly options: GVisorSandboxProvisionerOptions) {
    this.runscBinaryPath = options.runscBinaryPath ?? "runsc"
    this.runscRootDir = options.runscRootDir ?? "/var/run/peephole/runsc"
    this.bundlesRootDir = options.bundlesRootDir ?? "/var/lib/peephole/jobs"
    this.jobTimeoutMs =
      options.jobTimeoutMs ?? DEFAULT_RUNNER_TIMEOUTS.totalJobTimeoutMs
    this.processRunner = options.processRunner ?? new NodeProcessRunner()
    this.networkProvisioner =
      options.networkProvisioner ??
      new VethNatNetworkProvisioner({ processRunner: this.processRunner })
    this.now = options.now ?? (() => new Date())
  }

  async allocate(jobId: string): Promise<GVisorPreviewWorkspace> {
    const bundleDir = path.join(
      this.bundlesRootDir,
      `${jobId}-${randomBytes(4).toString("hex")}`,
    )
    const containerRoot = path.join(bundleDir, "rootfs")
    const rootDir = path.join(containerRoot, "workspace")

    await mkdir(bundleDir, { recursive: true })
    await cp(this.options.baseRootfsImage, containerRoot, {
      recursive: true,
      // The OCI runtime populates its own /dev (null, zero, tty, ptmx,
      // ...); fs.cp can't "copy" those device nodes as regular files
      // (ENODEV), so the base image's /dev, if any, is never carried into
      // the bundle.
      filter: (source) =>
        !isBaseRootfsDevPath(this.options.baseRootfsImage, source),
      // Without this, fs.cp resolves each symlink's relative target to an
      // absolute host path (e.g. base rootfs's npm -> ../lib/node_modules/...
      // becomes .../<baseRootfsImage>/usr/local/lib/node_modules/...), so
      // the copy's symlinks point back at the shared base image instead of
      // themselves -- which the sandboxed container can't see at all,
      // breaking every symlinked executable (npm, npx, corepack).
      verbatimSymlinks: true,
    })
    await mkdir(rootDir, { recursive: true })
    // Host-side extraction/output code and the sandboxed process (a fixed,
    // unprivileged uid/gid with no relation to whatever uid this
    // orchestrator runs as -- see SANDBOX_UID/SANDBOX_GID in
    // runscCommandRunner.ts) both need to write into rootDir; nothing in it
    // is sensitive (it becomes this job's downloaded source and build
    // output, not secrets), and the directory is destroyed with the rest of
    // the bundle when the job ends.
    await chmod(rootDir, 0o777)
    // fs.cp does not preserve source ownership -- the copy is owned by
    // whichever uid this orchestrator runs as, not the base image's
    // SANDBOX_UID:SANDBOX_GID, so the sandboxed process's own home
    // directory (npm's cache/config/log location) needs the same repair.
    // chown to an arbitrary uid needs root/CAP_CHOWN, which the real
    // gVisor worker always has (runsc itself needs it too); anywhere this
    // fails with EPERM can't run real runsc either, so skipping it there
    // doesn't hide a reachable production failure -- it just keeps
    // fake-runsc unit tests (tests/gvisorAdapter.test.ts) working without
    // requiring root.
    await chown(
      path.join(containerRoot, SANDBOX_HOME),
      SANDBOX_UID,
      SANDBOX_GID,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EPERM") throw error
    })

    const deadline = this.now().getTime() + this.jobTimeoutMs
    const containers = new Set<string>()
    let destroyed = false
    let networkNamespace: Promise<NetworkNamespaceHandle> | null = null
    const runscRootDir = this.runscRootDir
    const runscBinaryPath = this.runscBinaryPath
    const processRunner = this.processRunner
    const networkProvisioner = this.networkProvisioner
    const now = this.now

    return {
      id: jobId,
      rootDir,
      bundleDir,
      remainingMs: () => deadline - now().getTime(),
      registerContainer: (containerId) => containers.add(containerId),
      listContainers: () => Array.from(containers),
      ensureNetworkNamespace: async (dnsServers) => {
        networkNamespace ??= networkProvisioner.create(jobId, dnsServers)
        return (await networkNamespace).path
      },
      destroy: async () => {
        if (destroyed) {
          return
        }

        destroyed = true

        for (const containerId of containers) {
          await processRunner
            .run(
              runscBinaryPath,
              runscKillArgs({ runscRootDir }, containerId),
              { timeoutMs: 10_000 },
            )
            .catch(() => undefined)
          await processRunner
            .run(
              runscBinaryPath,
              runscDeleteArgs({ runscRootDir }, containerId),
              { timeoutMs: 10_000 },
            )
            .catch(() => undefined)
        }

        if (networkNamespace) {
          await networkNamespace
            .then((handle) => handle.teardown())
            .catch(() => undefined)
        }

        await rm(bundleDir, { recursive: true, force: true })
      },
    }
  }
}

function isBaseRootfsDevPath(baseRootfsImage: string, source: string): boolean {
  const relative = path.relative(baseRootfsImage, source)
  return relative === "dev" || relative.startsWith(`dev${path.sep}`)
}
