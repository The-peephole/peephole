import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { GVisorSandboxProvisioner } from "../services/preview-worker/gvisor/gvisorSandboxProvisioner"
import type { GVisorPreviewWorkspace } from "../services/preview-worker/gvisor/gvisorWorkspace"
import { RunscCommandRunner } from "../services/preview-worker/gvisor/runscCommandRunner"

// Requires a real Linux host with runsc on PATH and root (or equivalent)
// privilege, plus a prepared base rootfs image (see
// scripts/gvisor/build-base-rootfs.sh) -- opt-in, separate from
// PEEPHOLE_REAL_NETWORK_TESTS, since it needs a real Linux kernel, not just
// network access.
//
// This exercises GVisorSandboxProvisioner/RunscCommandRunner directly
// rather than through the full PreviewJobWorker pipeline: a real npm
// install needs outbound network from inside the sandbox
// (--network=sandbox), and manual testing against a real gVisor host
// (WSL2 Ubuntu) found that a bare `runsc run --network=sandbox` never
// brings the sandbox's virtual interface up -- even a raw TCP connect to a
// bare IP fails with ENETUNREACH, regardless of uid, capabilities, or
// mounts. `runsc do` (which is its own documented "testing only"
// convenience path, not what RunscCommandRunner calls) DOES work,
// confirming gVisor's sandbox netstack is not fundamentally broken on this
// kernel -- `do` just performs veth/IP/NAT setup that `create`/`run` alone
// does not, which normally comes from a CNI plugin under a full container
// platform (Docker/containerd). Giving RunscCommandRunner real network
// egress needs that same setup done explicitly; it does not exist yet
// (see IMPLEMENTATION_CHECKLIST.md, "Isolated Static Runner").
// So this file verifies everything network-independent instead: real
// non-root execution, real writes landing on host disk across two
// containers sharing one on-disk rootfs (the exact pattern
// NpmDependencyInstaller + NpmBuildExecutor rely on), and real PID-limit
// enforcement.
const baseRootfsImage =
  process.env.PEEPHOLE_GVISOR_BASE_ROOTFS ?? "/var/lib/peephole/base-rootfs"

describe.skipIf(!process.env.PEEPHOLE_REAL_GVISOR_TESTS)(
  "real gVisor sandbox (Linux + runsc required)",
  () => {
    let bundlesRootDir: string | undefined
    let workspace: GVisorPreviewWorkspace | undefined

    afterEach(async () => {
      await workspace?.destroy()
      if (bundlesRootDir)
        await rm(bundlesRootDir, { recursive: true, force: true })
      workspace = undefined
      bundlesRootDir = undefined
    })

    async function allocate(jobId: string) {
      bundlesRootDir = await mkdtemp(
        path.join(os.tmpdir(), "peephole-real-gvisor-"),
      )
      const provisioner = new GVisorSandboxProvisioner({
        baseRootfsImage,
        bundlesRootDir,
      })
      workspace = await provisioner.allocate(jobId)
      return workspace
    }

    it("runs as the declared unprivileged uid/gid, visible from the host", async () => {
      const ws = await allocate("real-gvisor-uid")
      const runner = new RunscCommandRunner({ network: "none" })

      await runner.run(ws, "sh", ["-c", "id -u > /workspace/uid.txt"], {
        timeoutMs: 15_000,
        env: { PATH: process.env.PATH ?? "" },
      })

      const uidFile = path.join(ws.rootDir, "uid.txt")
      expect((await readFile(uidFile, "utf8")).trim()).toBe("65534")
      const stats = await stat(uidFile)
      expect(stats.uid).toBe(65534)
      expect(stats.gid).toBe(65534)
    }, 30_000)

    it("persists writes to host disk, visible to a second container sharing the same rootfs", async () => {
      const ws = await allocate("real-gvisor-persist")
      const runner = new RunscCommandRunner({ network: "none" })

      // Simulates host-side archive extraction writing source files before
      // any container runs -- exactly what ExtractionState does.
      await writeFile(path.join(ws.rootDir, "input.txt"), "from-host\n")

      // First container: like the install phase, reads what the host
      // wrote and writes its own output (like node_modules).
      await runner.run(
        ws,
        "sh",
        ["-c", "cat /workspace/input.txt > /workspace/from-container-1.txt"],
        { timeoutMs: 15_000, env: { PATH: process.env.PATH ?? "" } },
      )

      // Second, separate container (its own containerId): like the build
      // phase, must see what the *first container* wrote.
      await runner.run(
        ws,
        "sh",
        [
          "-c",
          "cat /workspace/from-container-1.txt > /workspace/from-container-2.txt",
        ],
        { timeoutMs: 15_000, env: { PATH: process.env.PATH ?? "" } },
      )

      const finalContent = await readFile(
        path.join(ws.rootDir, "from-container-2.txt"),
        "utf8",
      )
      expect(finalContent).toBe("from-host\n")
    }, 30_000)

    it("enforces the configured PID limit", async () => {
      const ws = await allocate("real-gvisor-pids")
      const runner = new RunscCommandRunner({
        network: "none",
        resourceLimits: {
          cpuCount: 1,
          memoryBytes: 1_073_741_824,
          maxPids: 16,
        },
      })

      // Forks well past the 16-PID limit; expect the sandbox to refuse
      // (not silently allow unlimited forking).
      const forkBomb =
        "i=0; while [ $i -lt 200 ]; do sleep 5 & i=$((i+1)); done; wait"

      await expect(
        runner.run(ws, "sh", ["-c", forkBomb], {
          timeoutMs: 15_000,
          env: { PATH: process.env.PATH ?? "" },
        }),
      ).rejects.toThrow()
    }, 30_000)
  },
)
