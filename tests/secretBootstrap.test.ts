import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ChildProcess } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  parseDatabaseCredentialMaterial,
  parseSecretMaterial,
  runSecretBootstrap,
} from "../scripts/gvisor/secret-bootstrap.mjs"

const MARKER = "M10BMarker_7Hn9-Q"
const DATABASE_URL_MARKER =
  "postgresql://pv_x:M11CMarker_7Hn9-Q@192.168.253.1:5433/pv_x"

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
  let databaseCredentialFile: string
  let missingSecretFile: string
  let missingDatabaseCredentialFile: string

  beforeEach(async () => {
    temporaryDir = await mkdtemp(path.join(os.tmpdir(), "peephole-bootstrap-"))
    secretFile = path.join(temporaryDir, "env")
    databaseCredentialFile = path.join(temporaryDir, "database-url")
    // Neither file exists in the base rootfs image beyond an empty,
    // world-readable placeholder (see build-base-rootfs.sh) -- these two
    // paths model that placeholder rather than a genuinely missing mount.
    missingSecretFile = path.join(temporaryDir, "missing-env")
    missingDatabaseCredentialFile = path.join(
      temporaryDir,
      "missing-database-url",
    )
    await writeFile(missingSecretFile, "")
    await writeFile(missingDatabaseCredentialFile, "")
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
      databaseCredentialFile: missingDatabaseCredentialFile,
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
    expect(receivedEnvironment?.DATABASE_URL).toBeUndefined()
  })

  it("passes only the database credential when no generated-secret file is mounted", async () => {
    await writeFile(databaseCredentialFile, `${DATABASE_URL_MARKER}\n`, {
      mode: 0o600,
    })
    const child = new FakeChild()
    let receivedEnvironment: NodeJS.ProcessEnv | undefined
    const resultPromise = runSecretBootstrap({
      secretFile: missingSecretFile,
      databaseCredentialFile,
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
      DATABASE_URL: DATABASE_URL_MARKER,
    })
  })

  it("passes both generated secrets and the database credential together, exactly once each", async () => {
    await writeFile(secretFile, `SESSION_SECRET=${MARKER}\n`, { mode: 0o600 })
    await writeFile(databaseCredentialFile, `${DATABASE_URL_MARKER}\n`, {
      mode: 0o600,
    })
    const child = new FakeChild()
    let receivedEnvironment: NodeJS.ProcessEnv | undefined
    let spawnCount = 0
    const resultPromise = runSecretBootstrap({
      secretFile,
      databaseCredentialFile,
      nodeBinary: process.execPath,
      childArgs: ["server.js"],
      baseEnvironment: { PORT: "3000" },
      spawnChild: (_command, _args, options) => {
        spawnCount += 1
        receivedEnvironment = options.env
        queueMicrotask(() => child.emit("close", 0, null))
        return child as unknown as ChildProcess
      },
    })

    await expect(resultPromise).resolves.toEqual({ exitCode: 0, signal: null })
    expect(spawnCount).toBe(1)
    expect(receivedEnvironment).toEqual({
      PORT: "3000",
      SESSION_SECRET: MARKER,
      DATABASE_URL: DATABASE_URL_MARKER,
    })
  })

  it("neither credential file present leaves the base environment untouched", async () => {
    const child = new FakeChild()
    let receivedEnvironment: NodeJS.ProcessEnv | undefined
    const resultPromise = runSecretBootstrap({
      secretFile: missingSecretFile,
      databaseCredentialFile: missingDatabaseCredentialFile,
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
    expect(receivedEnvironment).toEqual({ PORT: "3000" })
  })

  it.each([
    ["empty", ""],
    ["oversized", `postgresql://pv_x:${"a".repeat(5_000)}@host:5433/pv_x\n`],
    [
      "embedded newline",
      `postgresql://pv_x:pw@host:5433/pv_x\nDROP TABLE users;\n`,
    ],
  ])(
    "fails closed for %s database credential material without printing the value",
    (_label, contents) => {
      let failure: unknown
      try {
        parseDatabaseCredentialMaterial(contents)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(Error)
      expect(String(failure)).not.toContain(DATABASE_URL_MARKER)
    },
  )

  it("never splits the database credential on '=' or parses it as additional environment names", () => {
    const value = parseDatabaseCredentialMaterial(
      "postgresql://pv_x:pw@host:5433/pv_x?options=-c%20x%3Dy\n",
    )
    expect(value).toBe("postgresql://pv_x:pw@host:5433/pv_x?options=-c%20x%3Dy")
  })

  it("normalizes at most one trailing newline for the database credential", () => {
    expect(parseDatabaseCredentialMaterial(DATABASE_URL_MARKER)).toBe(
      DATABASE_URL_MARKER,
    )
    expect(parseDatabaseCredentialMaterial(`${DATABASE_URL_MARKER}\n`)).toBe(
      DATABASE_URL_MARKER,
    )
  })

  it("bounds the URL VALUE itself, not the framed file -- a value at exactly the 4096-byte limit survives its own trailing newline", () => {
    // The writer (databaseCredentialFilesystem.ts's serializeDatabaseCredentialMaterial)
    // accepts a URL value up to 4096 bytes and then appends exactly one "\n",
    // producing a 4097-byte FILE for a value at the limit. This is the
    // M11-C3 review correction: the parser must measure the normalized
    // (post trailing-newline-strip) value, never the raw framed byte count,
    // or a valid at-the-limit value the writer just wrote becomes
    // unparseable here.
    const atLimit = "v".repeat(4096)
    const overLimit = "v".repeat(4097)
    expect(Buffer.byteLength(atLimit, "utf8")).toBe(4096)

    expect(parseDatabaseCredentialMaterial(atLimit)).toBe(atLimit)
    expect(parseDatabaseCredentialMaterial(`${atLimit}\n`)).toBe(atLimit)

    expect(() => parseDatabaseCredentialMaterial(overLimit)).toThrow(
      "Malformed database credential material.",
    )
    expect(() => parseDatabaseCredentialMaterial(`${overLimit}\n`)).toThrow(
      "Malformed database credential material.",
    )
  })

  it("end-to-end: a database credential file framed at the writer's own 4096-byte value limit reaches the child", async () => {
    const atLimit = "v".repeat(4096)
    await writeFile(databaseCredentialFile, `${atLimit}\n`, { mode: 0o600 })
    const child = new FakeChild()
    let receivedEnvironment: NodeJS.ProcessEnv | undefined
    const resultPromise = runSecretBootstrap({
      secretFile: missingSecretFile,
      databaseCredentialFile,
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
    expect(receivedEnvironment?.DATABASE_URL).toBe(atLimit)
  })

  it("rejects the database credential propagating through the generated-secret parser", () => {
    expect(() =>
      parseSecretMaterial(`DATABASE_URL=${DATABASE_URL_MARKER}\n`),
    ).toThrow("Malformed generated-secret material.")
  })

  it("fails closed when a real filesystem error other than ENOENT is raised while reading the database credential", async () => {
    // A directory instead of a file at the expected path exercises the
    // non-ENOENT branch of the optional-file read without needing platform
    // permission tricks.
    const asDirectory = path.join(temporaryDir, "database-url-is-a-dir")
    await mkdir(asDirectory)
    await expect(
      runSecretBootstrap({
        secretFile: missingSecretFile,
        databaseCredentialFile: asDirectory,
        childArgs: ["server.js"],
        spawnChild: () => {
          throw new Error("must not spawn a child on a read failure")
        },
      }),
    ).rejects.toThrow()
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
