import { EventEmitter } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ChildProcess } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  parseSecretMaterial,
  runSecretBootstrap,
} from "../scripts/gvisor/secret-bootstrap.mjs"

const MARKER = "M10BMarker_7Hn9-Q"

class FakeChild extends EventEmitter {
  killed = false
  readonly kill = vi.fn((signal?: NodeJS.Signals | number) => {
    this.killed = true
    return signal !== undefined
  })
}

describe("trusted secret bootstrap", () => {
  let temporaryDir: string
  let secretFile: string

  beforeEach(async () => {
    temporaryDir = await mkdtemp(path.join(os.tmpdir(), "peephole-bootstrap-"))
    secretFile = path.join(temporaryDir, "env")
  })

  afterEach(async () => {
    await rm(temporaryDir, { recursive: true, force: true })
  })

  it("passes valid generated material to the direct child only in memory", async () => {
    await writeFile(secretFile, `SESSION_SECRET=${MARKER}\n`, { mode: 0o600 })
    const child = new FakeChild()
    let receivedEnvironment: NodeJS.ProcessEnv | undefined
    const resultPromise = runSecretBootstrap({
      secretFile,
      nodeBinary: process.execPath,
      childArgs: ["server.js"],
      baseEnvironment: { PORT: "3000" },
      spawnChild: (_command, _args, options) => {
        receivedEnvironment = options.env
        queueMicrotask(() => child.emit("close", 0, null))
        return child as unknown as ChildProcess
      },
    })

    await expect(resultPromise).resolves.toEqual({ exitCode: 0, signal: null })
    expect(receivedEnvironment).toEqual({
      PORT: "3000",
      SESSION_SECRET: MARKER,
    })
  })

  it.each([
    ["missing final newline", `SESSION_SECRET=${MARKER}`],
    ["malformed line", "SESSION_SECRET\n"],
    ["unknown name", `UNKNOWN_SECRET=${MARKER}\n`],
    ["reserved name", `NODE_OPTIONS=${MARKER}\n`],
    [
      "duplicate name",
      `SESSION_SECRET=${MARKER}\nSESSION_SECRET=SecondValue_2\n`,
    ],
  ])("fails closed for %s without printing the value", (_label, contents) => {
    let failure: unknown
    try {
      parseSecretMaterial(contents)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain(MARKER)
  })

  it("propagates the child exit code structurally", async () => {
    await writeFile(secretFile, `JWT_SECRET=${MARKER}\n`)
    const child = new FakeChild()
    const result = runSecretBootstrap({
      secretFile,
      childArgs: ["server.js"],
      spawnChild: () => {
        queueMicrotask(() => child.emit("close", 23, null))
        return child as unknown as ChildProcess
      },
    })

    await expect(result).resolves.toEqual({ exitCode: 23, signal: null })
  })

  it("forwards termination to the direct child and reports its signal", async () => {
    await writeFile(secretFile, `CSRF_SECRET=${MARKER}\n`)
    const child = new FakeChild()
    let markSpawned: (() => void) | undefined
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve
    })
    const result = runSecretBootstrap({
      secretFile,
      childArgs: ["server.js"],
      spawnChild: () => {
        markSpawned?.()
        return child as unknown as ChildProcess
      },
    })
    await spawned

    process.emit("SIGTERM")
    expect(child.kill).toHaveBeenCalledWith("SIGTERM")
    child.emit("close", null, "SIGTERM")
    await expect(result).resolves.toEqual({
      exitCode: null,
      signal: "SIGTERM",
    })
  })
})
