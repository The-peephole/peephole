import { readFile, rm } from "node:fs/promises"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { GVisorSandboxProvisioner } from "../services/preview-worker/gvisor/gvisorSandboxProvisioner"
import type { GVisorPreviewWorkspace } from "../services/preview-worker/gvisor/gvisorWorkspace"
import { RunscCommandRunner } from "../services/preview-worker/gvisor/runscCommandRunner"
import { createRealGvisorTestDirectory } from "./support/realGvisorTestRoot"

// Requires a real Linux host with runsc, ip, and iptables on PATH and root
// (or equivalent) privilege, plus a prepared base rootfs image -- see
// tests/realGvisorSandbox.test.ts for the full setup note.
//
// A malicious npm postinstall/build script is the single most common
// real-world supply-chain attack against exactly the kind of "clone and
// build an arbitrary repository" flow this project does. These scripts
// simulate what one would try: escape the workspace, read host secrets,
// escalate privileges, and reach the sandbox's own network gateway.
const baseRootfsImage =
  process.env.PEEPHOLE_GVISOR_BASE_ROOTFS ?? "/var/lib/peephole/base-rootfs"

describe.skipIf(!process.env.PEEPHOLE_REAL_GVISOR_TESTS)(
  "real gVisor sandbox vs. adversarial scripts (Linux + runsc required)",
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
        "peephole-real-gvisor-malicious-",
      )
      const provisioner = new GVisorSandboxProvisioner({
        baseRootfsImage,
        bundlesRootDir,
      })
      workspace = await provisioner.allocate(jobId)
      return workspace
    }

    async function runScript(
      ws: GVisorPreviewWorkspace,
      script: string,
      network: "none" | "sandbox" = "none",
    ) {
      const runner = new RunscCommandRunner({ network })
      // Errors are captured to a result file rather than left to reject
      // run(), so a script that's merely denied (not crashed) still lets
      // the test see exactly what happened.
      const wrapped = `try{${script}}catch(e){require('fs').writeFileSync('/workspace/result.txt','SCRIPT_ERROR: '+e.message)}`
      await runner.run(ws, "node", ["-e", wrapped], {
        timeoutMs: 15_000,
        env: { PATH: process.env.PATH ?? "" },
      })
      return readFile(path.join(ws.rootDir, "result.txt"), "utf8").catch(
        () => "",
      )
    }

    it("cannot write outside the workspace through a symlink", async () => {
      const ws = await allocate("malicious-symlink")
      const result = await runScript(
        ws,
        `const fs=require('fs');fs.symlinkSync('/etc','/workspace/escape');fs.writeFileSync('/workspace/escape/peephole-pwned','pwned');fs.writeFileSync('/workspace/result.txt','WROTE THROUGH SYMLINK')`,
      )
      expect(result).toContain("SCRIPT_ERROR")
      expect(result).not.toContain("WROTE THROUGH SYMLINK")
    }, 30_000)

    it("cannot read /etc/shadow", async () => {
      const ws = await allocate("malicious-shadow")
      const result = await runScript(
        ws,
        `const fs=require('fs');const content=fs.readFileSync('/etc/shadow','utf8');fs.writeFileSync('/workspace/result.txt','READ SHADOW: '+content)`,
      )
      expect(result).toContain("SCRIPT_ERROR")
      expect(result).not.toContain("READ SHADOW")
    }, 30_000)

    it("cannot escalate to root via su or sudo", async () => {
      const ws = await allocate("malicious-privesc")
      const result = await runScript(
        ws,
        `const fs=require('fs');const {execSync}=require('child_process');const id=execSync('id').toString();let escalated='no';try{execSync('su -c id root 2>&1');escalated='su'}catch(e){}try{execSync('sudo id 2>&1');escalated='sudo'}catch(e){}fs.writeFileSync('/workspace/result.txt','id: '+id+' escalated: '+escalated)`,
      )
      expect(result).toContain("uid=65534")
      expect(result).toContain("escalated: no")
    }, 30_000)

    it("has no default route when network is none", async () => {
      const ws = await allocate("malicious-noroute")
      const result = await runScript(
        ws,
        `const fs=require('fs');const {execSync}=require('child_process');let route='';try{route=execSync('cat /proc/net/route').toString()}catch(e){route='FAILED: '+e.message}fs.writeFileSync('/workspace/result.txt',route)`,
      )
      // Header row only ("Iface Destination Gateway ..."), no actual
      // route entries -- confirms network: "none" leaves no interface up
      // for a malicious script to reach anything through, including the
      // sandbox's own NAT gateway.
      const dataLines = result
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
      expect(dataLines.length).toBeLessThanOrEqual(1)
    }, 30_000)

    it("cannot reach the NAT gateway or another job's network from network: none", async () => {
      const ws = await allocate("malicious-gateway")
      const result = await runScript(
        ws,
        `const net=require('net');const fs=require('fs');const s=net.createConnection({host:'10.200.0.1',port:80,timeout:3000});s.on('connect',()=>{fs.writeFileSync('/workspace/result.txt','CONNECTED');s.end()});s.on('error',e=>fs.writeFileSync('/workspace/result.txt','BLOCKED: '+e.message));s.on('timeout',()=>{fs.writeFileSync('/workspace/result.txt','BLOCKED: timeout');s.destroy()})`,
      )
      expect(result).toContain("BLOCKED")
    }, 30_000)
  },
)
