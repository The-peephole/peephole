import path from "node:path"
import { describe, expect, it, vi } from "vitest"

import { InMemoryBackendRuntimeSecretBroker } from "../services/backend-runtime-worker/secretBroker"
import { initializeProductionGeneratedSecretRuntime } from "../services/production/generatedSecretRuntime"
import type { GeneratedSecretFilesystem } from "../services/preview-worker/gvisor/generatedSecretFilesystem"

function options() {
  return {
    secretRootDir: path.resolve("production-secrets"),
    baseRootfsImage: path.resolve("base-rootfs"),
    bundlesRootDir: path.resolve("bundles"),
    artifactStorageDir: path.resolve("artifacts"),
    orphanReaperMaxAgeMs: 123_000,
  }
}

function fakeFilesystem(rootDir = options().secretRootDir) {
  return {
    rootDir,
    create: vi.fn(),
    remove: vi.fn(),
  } satisfies GeneratedSecretFilesystem
}

describe("initializeProductionGeneratedSecretRuntime", () => {
  it("checks capability before startup reapAll and constructs the broker only afterward", async () => {
    const events: string[] = []
    const filesystem = fakeFilesystem()
    const broker = new InMemoryBackendRuntimeSecretBroker()
    const issue = vi.spyOn(broker, "issue")
    let filesystemOptions: unknown
    let reaperOptions: unknown

    const runtime = await initializeProductionGeneratedSecretRuntime(
      options(),
      {
        createFilesystem: (received) => {
          filesystemOptions = received
          return filesystem
        },
        createOrphanReaper: (received) => {
          reaperOptions = received
          return {
            reap: vi.fn().mockResolvedValue([]),
            reapAll: vi.fn(async () => {
              events.push("reapAll")
              return []
            }),
          }
        },
        ensureCapability: async () => {
          events.push("preflight")
        },
        createBroker: () => {
          events.push("broker")
          return broker
        },
      },
    )

    expect(events).toEqual(["preflight", "reapAll", "broker"])
    expect(filesystemOptions).toMatchObject({
      rootDir: options().secretRootDir,
      forbiddenRoots: [options().bundlesRootDir, options().artifactStorageDir],
    })
    expect(reaperOptions).toMatchObject({
      rootDir: options().secretRootDir,
      filesystem,
      maxAgeMs: options().orphanReaperMaxAgeMs,
    })
    expect(runtime).toMatchObject({ filesystem, secretBroker: broker })
    expect(issue).not.toHaveBeenCalled()
  })

  it("fails startup before reaping or broker construction when capability preflight fails", async () => {
    const reapAll = vi.fn().mockResolvedValue([])
    const createBroker = vi.fn(() => new InMemoryBackendRuntimeSecretBroker())

    await expect(
      initializeProductionGeneratedSecretRuntime(options(), {
        createFilesystem: () => fakeFilesystem(),
        createOrphanReaper: () => ({
          reap: vi.fn().mockResolvedValue([]),
          reapAll,
        }),
        ensureCapability: async () => {
          throw new Error("capability unavailable")
        },
        createBroker,
      }),
    ).rejects.toThrow("capability unavailable")

    expect(reapAll).not.toHaveBeenCalled()
    expect(createBroker).not.toHaveBeenCalled()
  })

  it("fails startup and does not construct a broker when reapAll fails", async () => {
    const createBroker = vi.fn(() => new InMemoryBackendRuntimeSecretBroker())

    await expect(
      initializeProductionGeneratedSecretRuntime(options(), {
        createFilesystem: () => fakeFilesystem(),
        createOrphanReaper: () => ({
          reap: vi.fn().mockResolvedValue([]),
          reapAll: vi.fn().mockRejectedValue(new Error("reap failed")),
        }),
        ensureCapability: vi.fn().mockResolvedValue(undefined),
        createBroker,
      }),
    ).rejects.toThrow("reap failed")

    expect(createBroker).not.toHaveBeenCalled()
  })

  it("rejects a filesystem whose root differs from the configured production root", async () => {
    const ensureCapability = vi.fn().mockResolvedValue(undefined)

    await expect(
      initializeProductionGeneratedSecretRuntime(options(), {
        createFilesystem: () => fakeFilesystem(path.resolve("other-root")),
        ensureCapability,
      }),
    ).rejects.toThrow(/roots must match/)

    expect(ensureCapability).not.toHaveBeenCalled()
  })
})
