import {
  lstat,
  readFile,
  rm,
  stat,
  statfs,
  utimes,
  writeFile,
} from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  resolveDnsConfig,
  resolveDnsConfigSource,
} from "../services/preview-worker/gvisor/dnsConfig"
import { GVisorOrphanReaper } from "../services/preview-worker/gvisor/gvisorOrphanReaper"
import { VethNatNetworkProvisioner } from "../services/preview-worker/gvisor/networkNamespace"
import { NetworkOrphanReaper } from "../services/preview-worker/gvisor/networkOrphanReaper"
import { NodeProcessRunner } from "../services/preview-worker/gvisor/nodeProcessRunner"
import { SANDBOX_DEV_SHM_TMPFS_BYTES } from "../services/preview-worker/gvisor/ociConfig"
import { GVisorSandboxProvisioner } from "../services/preview-worker/gvisor/gvisorSandboxProvisioner"
import type { GVisorPreviewWorkspace } from "../services/preview-worker/gvisor/gvisorWorkspace"
import { RunscCommandRunner } from "../services/preview-worker/gvisor/runscCommandRunner"
import {
  LoopbackSandboxDiskManager,
  MIN_SANDBOX_DISK_LIMIT_BYTES,
} from "../services/preview-worker/gvisor/sandboxDisk"
import {
  NetworkLeaseManager,
  type NetworkLease,
} from "../services/preview-worker/gvisor/subnetAllocator"
import { createRealGvisorTestDirectory } from "./support/realGvisorTestRoot"

// Requires a real Linux host with runsc, ip, iptables, and ip6tables on PATH and root
// (or equivalent) privilege, plus a prepared base rootfs image (see
// scripts/gvisor/build-base-rootfs.sh) -- opt-in, separate from
// PEEPHOLE_REAL_NETWORK_TESTS, since it needs a real Linux kernel, not just
// network access.
//
// This exercises GVisorSandboxProvisioner/RunscCommandRunner directly
// rather than through the full PreviewJobWorker pipeline: real non-root
// execution, real writes landing on the quota-backed ext4 filesystem across
// two containers sharing one workspace (the exact pattern NpmDependencyInstaller +
// NpmBuildExecutor rely on), real PID-limit enforcement, and -- since
// VethNatNetworkProvisioner replicates runsc do's veth/NAT setup -- real
// outbound network access and real metadata/link-local blocking.
const baseRootfsImage =
  process.env.PEEPHOLE_GVISOR_BASE_ROOTFS ?? "/var/lib/peephole/base-rootfs"
const HOST_IMAGE_ALLOCATION_TOLERANCE_BYTES = 1024 * 1024
const TMP_ZERO_FILE_LIMIT = 30_000
const HOST_METADATA_DISK_TOLERANCE_BYTES = 8 * 1024 * 1024

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
      bundlesRootDir = await createRealGvisorTestDirectory(
        "peephole-real-gvisor-",
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
      const workspaceStats = await stat(ws.rootDir)
      expect(workspaceStats.uid).toBe(65534)
      expect(workspaceStats.gid).toBe(65534)
      expect(workspaceStats.mode & 0o777).toBe(0o700)
      const stats = await stat(uidFile)
      expect(stats.uid).toBe(65534)
      expect(stats.gid).toBe(65534)
    }, 30_000)

    it("persists workspace writes across separate install/build-style containers", async () => {
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

    it("enforces read-only rootfs, bounded /tmp and /dev/shm, and audits /dev writability", async () => {
      const ws = await allocate("real-gvisor-filesystems")
      const runner = new RunscCommandRunner({ network: "none" })
      const workspaceBefore = await statfs(ws.rootDir)
      const workspaceUsedBefore =
        (workspaceBefore.blocks - workspaceBefore.bfree) * workspaceBefore.bsize
      const script = String.raw`
        const fs = require('fs');
        const canWrite = (file) => { try { fs.writeFileSync(file, 'x'); return true } catch { return false } };
        const capacity = (dir) => { const s=fs.statfsSync(dir); return { blocks:s.blocks,bfree:s.bfree,bavail:s.bavail,files:s.files,ffree:s.ffree,bsize:s.bsize,bytes:s.blocks*s.bsize,inodes:s.files } };
        const kind = (s) => s.isDirectory()?'directory':s.isCharacterDevice()?'character':s.isBlockDevice()?'block':s.isSymbolicLink()?'symlink':s.isFile()?'file':s.isFIFO()?'fifo':s.isSocket()?'socket':'other';
        const inspect = (file) => { try { const s=fs.lstatSync(file); return { exists:true,type:kind(s),mode:s.mode&0o7777,uid:s.uid,gid:s.gid,...(s.isDirectory()?{statfs:capacity(file)}:{}) } } catch(e) { return { exists:false,error:e.code||String(e) } } };
        const readMetric = (file) => { try { return fs.readFileSync(file,'utf8').trim() } catch(e) { return null } };
        const probeDirectoryWrite = (dir) => { const file=dir+'/.peephole-write-probe'; try { fs.writeFileSync(file,'x');fs.unlinkSync(file);return true } catch { return false } };
        const auditDevDirectories = (root) => { let names=[];try{names=fs.readdirSync(root)}catch(e){return [{path:root,listError:e.code||String(e)}]};const results=[];for(const name of names){const file=root+'/'+name;const details=inspect(file);if(details.type!=='directory')continue;results.push({path:file,writable:probeDirectoryWrite(file),...details});if(file!=='/dev/shm')results.push(...auditDevDirectories(file))}return results };
        let tmpBytes=0, tmpError='';
        try { for(let i=0;i<80;i++){ fs.appendFileSync('/tmp/capacity.bin', Buffer.alloc(1024*1024)); tmpBytes+=1024*1024 } }
        catch(e){ tmpError=e.code || String(e) }
        try { fs.unlinkSync('/tmp/capacity.bin') } catch {}
        let tmpZeroFilesCreated=0, tmpZeroFileError='';
        try { fs.mkdirSync('/tmp/zero-files'); for(;tmpZeroFilesCreated<${String(TMP_ZERO_FILE_LIMIT)};tmpZeroFilesCreated++) fs.writeFileSync('/tmp/zero-files/'+tmpZeroFilesCreated,'') }
        catch(e){ tmpZeroFileError=e.code || String(e) }
        const devEntries=fs.readdirSync('/dev').sort().map(name=>({name,path:'/dev/'+name,...inspect('/dev/'+name)}));
        const devDirectoryAudit=auditDevDirectories('/dev');
        const writableDevDirectories=devDirectoryAudit.filter(entry=>entry.writable).map(entry=>entry.path).sort();
        let shmBytes=0, shmError='';
        try { for(let i=0;i<32;i++){ fs.appendFileSync('/dev/shm/capacity.bin',Buffer.alloc(1024*1024));shmBytes+=1024*1024 } }
        catch(e){ shmError=e.code || String(e) }
        try { fs.unlinkSync('/dev/shm/capacity.bin') } catch {}
        fs.writeFileSync('/workspace/filesystems.json', JSON.stringify({
          etcWritable:canWrite('/etc/peephole-test'),
          homeWritable:canWrite('/home/sandbox/escape'),
          varTmpWritable:canWrite('/var/tmp/escape'),
          workspaceWritable:canWrite('/workspace/allowed'),
          devWritable:canWrite('/dev/peephole-test'),
          home:process.env.HOME, npmCache:process.env.npm_config_cache,
          tmp:capacity('/tmp'), dev:capacity('/dev'), tmpBytes, tmpError,
          tmpZeroFilesCreated,tmpZeroFileError,
          cgroupMemory:{current:readMetric('/sys/fs/cgroup/memory.current'),peak:readMetric('/sys/fs/cgroup/memory.peak'),events:readMetric('/sys/fs/cgroup/memory.events')},
          processMemory:process.memoryUsage(),
          devEntries,devDirectoryAudit,writableDevDirectories,
          shm:inspect('/dev/shm'),shmBytes,shmError,
          mqueue:inspect('/dev/mqueue'),mqueueWritable:probeDirectoryWrite('/dev/mqueue')
        }));
      `

      await runner.run(ws, "node", ["-e", script], {
        timeoutMs: 60_000,
        env: { PATH: process.env.PATH ?? "" },
      })
      const result = JSON.parse(
        await readFile(path.join(ws.rootDir, "filesystems.json"), "utf8"),
      )
      const workspaceAfter = await statfs(ws.rootDir)
      const workspaceUsedAfter =
        (workspaceAfter.blocks - workspaceAfter.bfree) * workspaceAfter.bsize
      process.stdout.write(
        `[real-gvisor-dev-audit] ${JSON.stringify({ tmp: result.tmp, tmpBytes: result.tmpBytes, tmpError: result.tmpError, tmpZeroFilesCreated: result.tmpZeroFilesCreated, tmpZeroFileError: result.tmpZeroFileError, cgroupMemory: result.cgroupMemory, processMemory: result.processMemory, workspaceUsedBefore, workspaceUsedAfter, dev: result.dev, devEntries: result.devEntries, devDirectoryAudit: result.devDirectoryAudit, writableDevDirectories: result.writableDevDirectories, shm: result.shm, shmBytes: result.shmBytes, shmError: result.shmError, mqueue: result.mqueue, mqueueWritable: result.mqueueWritable })}\n`,
      )
      expect(result.etcWritable).toBe(false)
      expect(result.homeWritable).toBe(false)
      expect(result.varTmpWritable).toBe(false)
      expect(result.workspaceWritable).toBe(true)
      expect(result.devWritable).toBe(false)
      expect(result.home).toBe("/workspace/.home")
      expect(result.npmCache).toBe("/workspace/.home/.npm")
      expect(result.tmp.bytes).toBeLessThanOrEqual(64 * 1024 * 1024)
      expect(result.tmpBytes).toBeLessThan(80 * 1024 * 1024)
      expect(result.tmpError).toBeTruthy()
      expect(result.tmpZeroFilesCreated).toBeGreaterThan(0)
      expect(result.tmpZeroFilesCreated).toBeLessThanOrEqual(
        TMP_ZERO_FILE_LIMIT,
      )
      expect(workspaceUsedAfter - workspaceUsedBefore).toBeLessThanOrEqual(
        HOST_METADATA_DISK_TOLERANCE_BYTES,
      )
      await expect(
        lstat(path.join(ws.bundleDir, "rootfs", "tmp", "zero-files")),
      ).rejects.toMatchObject({ code: "ENOENT" })
      expect(result.shm).toMatchObject({
        exists: true,
        type: "directory",
        mode: 0o1777,
        uid: 0,
        gid: 0,
      })
      expect(result.shm.statfs.bytes).toBeLessThanOrEqual(
        SANDBOX_DEV_SHM_TMPFS_BYTES,
      )
      expect(result.shmBytes).toBeLessThan(32 * 1024 * 1024)
      expect(result.shmError).toBeTruthy()
      expect(result.writableDevDirectories).toEqual(["/dev/shm"])
      expect(result.mqueueWritable).toBe(false)
      for (const device of ["null", "zero", "full", "random", "urandom"]) {
        expect(
          result.devEntries.find(
            (entry: { name: string }) => entry.name === device,
          ),
        ).toMatchObject({ type: "character", uid: 0, gid: 0 })
      }

      // A bounded metadata-pressure run must not damage the worker/runsc path.
      await runner.run(ws, "node", ["-e", "process.exit(0)"], {
        timeoutMs: 15_000,
        env: { PATH: process.env.PATH ?? "" },
      })
    }, 90_000)

    it("stops an untrusted writer at the ext4 workspace hard capacity", async () => {
      bundlesRootDir = await createRealGvisorTestDirectory(
        "peephole-real-gvisor-disk-cap-",
      )
      const hardLimitBytes = 2 * MIN_SANDBOX_DISK_LIMIT_BYTES
      const diskManager = new LoopbackSandboxDiskManager({
        bundlesRootDir,
        hardLimitBytes,
        minimumHostReserveBytes: 0,
      })
      const provisioner = new GVisorSandboxProvisioner({
        baseRootfsImage,
        diskManager,
      })
      workspace = await provisioner.allocate("fixture-id-format-is-irrelevant")
      const runner = new RunscCommandRunner({ network: "none" })
      const imagePath = path.join(workspace.bundleDir, "workspace.img")
      expect((await stat(imagePath)).size).toBe(hardLimitBytes)
      const fill =
        "const fs=require('fs');try{for(let i=0;i<600;i++)fs.appendFileSync('/workspace/fill',Buffer.alloc(1024*1024))}catch(e){console.error(e.code);process.exit(1)}"

      let writeFailure: unknown
      try {
        await runner.run(workspace, "node", ["-e", fill], {
          timeoutMs: 60_000,
          env: { PATH: process.env.PATH ?? "" },
        })
      } catch (error) {
        writeFailure = error
      }
      expect(writeFailure).toBeInstanceOf(Error)

      const fillStats = await stat(path.join(workspace.rootDir, "fill"))
      const imageStats = await stat(imagePath)
      const filesystem = await statfs(workspace.rootDir)
      const totalBytes = filesystem.blocks * filesystem.bsize
      const usedBytes =
        (filesystem.blocks - filesystem.bfree) * filesystem.bsize
      const fillAllocatedBytes = fillStats.blocks * 512
      const imageAllocatedBytes = imageStats.blocks * 512
      const observation = {
        blocks: filesystem.blocks,
        bfree: filesystem.bfree,
        bavail: filesystem.bavail,
        files: filesystem.files,
        ffree: filesystem.ffree,
        bsize: filesystem.bsize,
        totalBytes,
        usedBytes,
        fillLogicalBytes: fillStats.size,
        fillAllocatedBytes,
        imageLogicalBytes: imageStats.size,
        imageAllocatedBytes,
        failureClass:
          writeFailure instanceof Error
            ? writeFailure.constructor.name
            : typeof writeFailure,
      }
      process.stdout.write(
        `[real-gvisor-hard-cap] ${JSON.stringify(observation)}\n`,
      )

      expect(fillStats.size).toBeLessThan(600 * 1024 * 1024)
      expect(fillStats.size).toBeLessThanOrEqual(totalBytes)
      expect(totalBytes).toBeLessThanOrEqual(hardLimitBytes)
      expect(totalBytes).toBeGreaterThanOrEqual(hardLimitBytes * 0.5)
      expect(usedBytes).toBeLessThanOrEqual(totalBytes)
      expect(fillAllocatedBytes).toBeLessThanOrEqual(totalBytes)
      expect(imageStats.size).toBe(hardLimitBytes)
      expect(imageAllocatedBytes).toBeLessThanOrEqual(
        hardLimitBytes + HOST_IMAGE_ALLOCATION_TOLERANCE_BYTES,
      )

      // The failed untrusted writer must not take down the worker/runsc path.
      await runner.run(workspace, "node", ["-e", "process.exit(0)"], {
        timeoutMs: 15_000,
        env: { PATH: process.env.PATH ?? "" },
      })
    }, 90_000)

    it("removes the verified mount, loop, image, and bundle on normal destroy", async () => {
      const ws = await allocate("real-gvisor-cleanup")
      const bundleDir = ws.bundleDir
      await ws.destroy()
      workspace = undefined

      await expect(stat(bundleDir)).rejects.toThrow()
    }, 30_000)

    it("reaps a container abandoned mid-run by a crashed worker", async () => {
      // No allocate()/afterEach here: this simulates a worker process
      // that crashed while a container was still running, so nothing
      // tracks or cleans up this workspace except the reaper itself.
      const dir = await createRealGvisorTestDirectory(
        "peephole-real-gvisor-reaper-",
      )
      bundlesRootDir = dir
      const provisioner = new GVisorSandboxProvisioner({
        baseRootfsImage,
        bundlesRootDir: dir,
      })
      const ws = await provisioner.allocate("real-gvisor-orphan")
      const runner = new RunscCommandRunner({ network: "none" })

      // Fire and forget: a long-lived container left running, exactly
      // like an in-progress `npm ci` would be when the worker process
      // dies. Its eventual rejection (once the reaper kills it below) is
      // expected, not a test failure.
      const abandoned = runner
        .run(ws, "sleep", ["30"], {
          timeoutMs: 45_000,
          env: { PATH: process.env.PATH ?? "" },
        })
        .catch(() => undefined)

      await new Promise((resolve) => setTimeout(resolve, 1_500))

      // Age the bundle directory itself so the reaper's mtime-based
      // staleness check finds it (it was created moments ago).
      const old = new Date(Date.now() - 60 * 60_000)
      await utimes(ws.bundleDir, old, old)

      const reaper = new GVisorOrphanReaper({
        bundlesRootDir: dir,
        maxAgeMs: 30 * 60_000,
      })
      const reaped = await reaper.reap()

      expect(reaped).toEqual([path.basename(ws.bundleDir)])
      await expect(stat(ws.bundleDir)).rejects.toThrow()

      await abandoned
      await rm(dir, { recursive: true, force: true })
      bundlesRootDir = undefined
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

    it("enforces the configured memory limit", async () => {
      const ws = await allocate("real-gvisor-memory")
      const runner = new RunscCommandRunner({
        network: "none",
        resourceLimits: {
          cpuCount: 1,
          memoryBytes: 64 * 1024 * 1024,
          maxPids: 128,
        },
      })

      // Allocates and touches (forces physical commit of) 200MB against a
      // 64MB cgroup limit -- Buffer.alloc is off the V8 heap, so this
      // exercises the OS/cgroup memory limit, not V8's own heap ceiling.
      // Expect the OOM killer to end the process (not a graceful failure).
      const memoryHog =
        "const b=Buffer.alloc(200*1024*1024);for(let i=0;i<b.length;i+=4096)b[i]=1;console.log('survived')"

      await expect(
        runner.run(ws, "node", ["-e", memoryHog], {
          timeoutMs: 15_000,
          env: { PATH: process.env.PATH ?? "" },
        }),
      ).rejects.toThrow()
    }, 30_000)

    it("throttles CPU usage to roughly the configured quota", async () => {
      // Measured from outside the sandbox (wall-clock around the run()
      // call), not via getrusage()/process.cpuUsage() inside it -- gVisor
      // virtualizes those, and a fixed amount of real CPU-bound work
      // (repeated SHA-256) simply takes proportionally longer in wall
      // time when the cgroup CFS quota restricts it to a fifth of a core,
      // regardless of how faithfully the sandbox reports its own usage.
      const hashWorkload = (iterations: number) =>
        `const crypto=require('crypto');let x=Buffer.from('start');for(let i=0;i<${iterations};i++){x=crypto.createHash('sha256').update(x).digest()}`

      // Each call gets its own provisioner/bundlesRootDir (not the shared
      // allocate() helper, which only tracks one workspace at a time for
      // afterEach) so the two timed runs can't interfere with each other.
      const time = async (cpuCount: number, iterations: number) => {
        const dir = await createRealGvisorTestDirectory(
          "peephole-real-gvisor-cpu-",
        )
        const provisioner = new GVisorSandboxProvisioner({
          baseRootfsImage,
          bundlesRootDir: dir,
        })
        const ws = await provisioner.allocate(`real-gvisor-cpu-${cpuCount}`)
        const runner = new RunscCommandRunner({
          network: "none",
          resourceLimits: { cpuCount, memoryBytes: 1_073_741_824, maxPids: 32 },
        })
        try {
          const start = Date.now()
          await runner.run(ws, "node", ["-e", hashWorkload(iterations)], {
            timeoutMs: 60_000,
            env: { PATH: process.env.PATH ?? "" },
          })
          return Date.now() - start
        } finally {
          await ws.destroy()
          await rm(dir, { recursive: true, force: true })
        }
      }

      const iterations = 400_000
      const generousMs = await time(4, iterations)
      const throttledMs = await time(0.1, iterations)

      expect(throttledMs).toBeGreaterThan(generousMs * 2)
    }, 90_000)

    it("resolves a real, non-loopback DNS config source on this host", async () => {
      // Regression test for a real AWS EC2 (Ubuntu, systemd-resolved)
      // finding: /etc/resolv.conf there points at the 127.0.0.53 stub,
      // which only systemd-resolved's host-netns listener answers on --
      // bind-mounted verbatim into the sandbox's own network namespace,
      // nothing is listening there and every DNS lookup fails. This calls
      // the real (non-fake-readFile) resolveDnsConfigSource() against
      // whatever this host actually has, and asserts the file it picks
      // has at least one nameserver that isn't a loopback address --
      // which is exactly the property that made the "reaches the real
      // internet" test below fail before this fix, on that host.
      const source = resolveDnsConfigSource()
      const content = await readFile(source, "utf8")
      const nameserverLines = content
        .split("\n")
        .filter((line) => /^\s*nameserver\s+\S+/.test(line))

      expect(nameserverLines.length).toBeGreaterThan(0)
      expect(nameserverLines.some((line) => /127\.0\.0\.\d+/.test(line))).toBe(
        false,
      )
    })

    it("reaches the real internet through network: sandbox", async () => {
      const ws = await allocate("real-gvisor-net")
      const runner = new RunscCommandRunner({ network: "sandbox" })

      await runner.run(
        ws,
        "node",
        ["-e", fetchToFileScript("/workspace/fetch.json")],
        {
          timeoutMs: 20_000,
          env: { PATH: process.env.PATH ?? "" },
        },
      )

      const body = await readFile(path.join(ws.rootDir, "fetch.json"), "utf8")
      expect(JSON.parse(body)).toMatchObject({ name: "yallist" })
    }, 30_000)

    it("reconciles a real abandoned network lease and every owned host resource", async () => {
      const testRoot = await createRealGvisorTestDirectory(
        "peephole-real-network-reaper-",
      )
      const leaseDir = path.join(testRoot, "leases")
      const leaseManager = new NetworkLeaseManager({
        leaseDir,
        // This fixture deliberately represents a dead worker after setup.
        processExists: () => false,
      })
      const processRunner = new NodeProcessRunner()
      const provisioner = new VethNatNetworkProvisioner({
        leaseManager,
        processRunner,
      })
      let created = false
      try {
        created = true
        await provisioner.create("e".repeat(32), resolveDnsConfig().nameservers)
        const [lease] = await leaseManager.listOwnedLeases()
        if (!lease) throw new Error("expected a durable network lease")

        const before = await inspectRealNetworkResources(processRunner, lease)
        expect(before.namespace).toBe(true)
        expect(before.hostVeth).toBe(true)
        expect(before.ipv4).toBe(true)
        expect(before.nat).toBe(true)
        expect(before.ipv6).toBe(true)

        await new NetworkOrphanReaper({
          leaseManager,
          processRunner,
        }).reapAll()

        const after = await inspectRealNetworkResources(processRunner, lease)
        expect(after).toEqual({
          namespace: false,
          hostVeth: false,
          ipv4: false,
          nat: false,
          ipv6: false,
        })
        expect(await leaseManager.listOwnedLeases()).toEqual([])
        created = false
      } finally {
        // If the assertion/reaper failed, retry the same marker-verified path;
        // never issue wildcard host cleanup from the test harness.
        if (created) {
          try {
            await new NetworkOrphanReaper({
              leaseManager,
              processRunner,
            }).reapAll()
            created = false
          } catch (error) {
            process.stderr.write(
              `Real network fixture cleanup failed; ownership lease was preserved at ${leaseDir}: ${String(error)}\n`,
            )
          }
        }
        if (!created) await rm(testRoot, { recursive: true, force: true })
      }
    }, 30_000)

    it("blocks the cloud metadata address even with network: sandbox", async () => {
      const ws = await allocate("real-gvisor-metadata")
      const runner = new RunscCommandRunner({ network: "sandbox" })

      await expect(
        runner.run(ws, "node", ["-e", metadataProbeScript], {
          timeoutMs: 10_000,
          env: { PATH: process.env.PATH ?? "" },
        }),
      ).rejects.toThrow()
    }, 20_000)

    it("blocks services bound to the sandbox veth gateway on the host", async () => {
      const ws = await allocate("real-gvisor-host-service")
      const dnsConfig = resolveDnsConfig()
      const networkPath = await ws.ensureNetworkNamespace(dnsConfig.nameservers)
      const match = /peephole-(\d+)$/.exec(networkPath)
      if (!match?.[1]) throw new Error(`unexpected netns path: ${networkPath}`)

      const blockStart = Number(match[1]) * 4
      const hostIp = `10.200.${String(Math.floor(blockStart / 256) % 256)}.${String((blockStart % 256) + 1)}`
      const server = createServer((_request, response) => response.end("host"))

      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject)
          server.listen(0, hostIp, resolve)
        })
        const address = server.address()
        if (!address || typeof address === "string") {
          throw new Error("host probe server did not bind a TCP port")
        }

        const runner = new RunscCommandRunner({ network: "sandbox" })
        const url = `http://${hostIp}:${String(address.port)}/`
        await expect(
          runner.run(ws, "node", ["-e", rejectedFetchScript(url)], {
            timeoutMs: 10_000,
            env: { PATH: process.env.PATH ?? "" },
          }),
        ).rejects.toThrow()
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }, 20_000)

    it("gives concurrent jobs independent, non-conflicting networks", async () => {
      const wsA = await allocate("real-gvisor-net-a")
      const runnerA = new RunscCommandRunner({ network: "sandbox" })
      const bundlesRootB = await createRealGvisorTestDirectory(
        "peephole-real-gvisor-",
      )
      const provisionerB = new GVisorSandboxProvisioner({
        baseRootfsImage,
        bundlesRootDir: bundlesRootB,
      })
      const wsB = await provisionerB.allocate("real-gvisor-net-b")
      const runnerB = new RunscCommandRunner({ network: "sandbox" })

      try {
        await Promise.all([
          runnerA.run(
            wsA,
            "node",
            ["-e", fetchToFileScript("/workspace/out.json")],
            {
              timeoutMs: 20_000,
              env: { PATH: process.env.PATH ?? "" },
            },
          ),
          runnerB.run(
            wsB,
            "node",
            ["-e", fetchToFileScript("/workspace/out.json")],
            {
              timeoutMs: 20_000,
              env: { PATH: process.env.PATH ?? "" },
            },
          ),
        ])

        const bodyA = JSON.parse(
          await readFile(path.join(wsA.rootDir, "out.json"), "utf8"),
        )
        const bodyB = JSON.parse(
          await readFile(path.join(wsB.rootDir, "out.json"), "utf8"),
        )
        expect(bodyA).toMatchObject({ name: "yallist" })
        expect(bodyB).toMatchObject({ name: "yallist" })
      } finally {
        await wsB.destroy()
        await rm(bundlesRootB, { recursive: true, force: true })
      }
    }, 30_000)
  },
)

// The base rootfs image (scripts/gvisor/build-base-rootfs.sh) has no
// wget/curl, only node -- these are `node -e` scripts, not shell.
function fetchToFileScript(outFile: string): string {
  return `fetch('https://registry.npmjs.org/yallist',{signal:AbortSignal.timeout(15000)}).then(r=>r.text()).then(t=>require('fs').writeFileSync(${JSON.stringify(outFile)},t)).catch(e=>{console.error(String(e));process.exit(1)})`
}

const metadataProbeScript =
  "fetch('http://169.254.169.254/',{signal:AbortSignal.timeout(5000)}).then(()=>{console.log('REACHED');process.exit(0)}).catch(e=>{console.error('BLOCKED',String(e));process.exit(1)})"

function rejectedFetchScript(url: string): string {
  return `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(5000)}).then(()=>{console.log('REACHED');process.exit(0)}).catch(e=>{console.error('BLOCKED',String(e));process.exit(1)})`
}

async function inspectRealNetworkResources(
  runner: NodeProcessRunner,
  lease: NetworkLease,
) {
  const [namespaces, links, ipv4, nat, ipv6] = await Promise.all([
    runner.run("ip", ["netns", "list"], { timeoutMs: 10_000 }),
    runner.run("ip", ["-o", "link", "show"], { timeoutMs: 10_000 }),
    runner.run("iptables", ["-w", "5", "-S"], { timeoutMs: 10_000 }),
    runner.run("iptables", ["-w", "5", "-t", "nat", "-S"], {
      timeoutMs: 10_000,
    }),
    runner.run("ip6tables", ["-w", "5", "-S"], { timeoutMs: 10_000 }),
  ])
  for (const command of [namespaces, links, ipv4, nat, ipv6]) {
    expect(command.exitCode).toBe(0)
    expect(command.timedOut).toBe(false)
  }
  return {
    namespace: namespaces.stdout.includes(lease.namespace),
    hostVeth: links.stdout.includes(lease.hostVeth),
    ipv4:
      ipv4.stdout.includes(lease.egressChain) &&
      ipv4.stdout.includes(lease.inputChain) &&
      ipv4.stdout.includes(lease.returnChain),
    nat: nat.stdout.includes(lease.iptablesComment),
    ipv6: ipv6.stdout.includes(lease.hostVeth),
  }
}
