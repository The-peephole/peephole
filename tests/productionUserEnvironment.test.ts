import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"

import { readProductionConfig } from "../services/production/config"
import {
  ensureUserEnvironmentCapability,
  type RootfsEntry,
} from "../services/production/preflight"
import { initializeProductionUserEnvironmentRuntime } from "../services/production/userEnvironmentRuntime"
import { composeProductionBackendRuntime } from "../services/preview-worker/gvisor/composeProductionBackendRuntime"
import { SANDBOX_USER_ENVIRONMENT_BOOTSTRAP_FLAG } from "../services/preview-worker/gvisor/sandboxIdentity"
import type {
  ProcessRunner,
  ProcessRunResult,
} from "../services/preview-worker/gvisor/processRunner"
import { InMemoryUserEnvironmentBroker } from "../services/user-environment/userEnvironmentBroker"
import { TmpfsUserEnvironmentFilesystem } from "../services/preview-worker/gvisor/userEnvironmentFilesystem"
import { LiveBackendRuntimeRegistry } from "../services/backend-runtime-worker/liveRuntimeRegistry"
import { InMemoryBackendRuntimeSecretBroker } from "../services/backend-runtime-worker/secretBroker"
import { TmpfsGeneratedSecretFilesystem } from "../services/preview-worker/gvisor/generatedSecretFilesystem"
import type { BackendRuntimeControlPlane } from "../services/backend-runtime-api/controlPlane"

const tmpfsRunner: ProcessRunner = {
  run: async (): Promise<ProcessRunResult> => ({
    exitCode: 0,
    timedOut: false,
    stdout: "tmpfs\n",
    stderr: "",
  }),
}

const placeholder: RootfsEntry = { kind: "file", size: 0, uid: 0, mode: 0o644 }

describe("PEEPHOLE_USER_ENVIRONMENT configuration", () => {
  it("defaults off with the dedicated tmpfs root", () => {
    expect(readProductionConfig({}).userEnvironment).toEqual({
      enabled: false,
      rootDir: "/run/peephole/user-env",
    })
  })

  it.each([
    ["", false],
    ["0", false],
    ["1", true],
    [" 1 ", true],
  ])("reads %j as enabled=%s", (flag, enabled) => {
    expect(
      readProductionConfig({ PEEPHOLE_USER_ENVIRONMENT: flag }).userEnvironment
        .enabled,
    ).toBe(enabled)
  })

  it.each(["true", "yes", "2", "on"])(
    "refuses the ambiguous flag %j",
    (flag) => {
      expect(() =>
        readProductionConfig({ PEEPHOLE_USER_ENVIRONMENT: flag }),
      ).toThrow(/PEEPHOLE_USER_ENVIRONMENT must be 0 or 1/)
    },
  )

  it("requires an absolute root", () => {
    expect(() =>
      readProductionConfig({ PEEPHOLE_USER_ENVIRONMENT_ROOT: "user-env" }),
    ).toThrow()
  })
})

describe("ensureUserEnvironmentCapability", () => {
  async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "peephole-m12-preflight-"))
    try {
      await run(path.join(dir, "user-env"))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it("accepts a tmpfs root, the empty placeholder, and an M12-aware bootstrap", async () => {
    await withRoot(async (rootDir) => {
      await expect(
        ensureUserEnvironmentCapability({
          rootDir,
          baseRootfsImage: "/rootfs",
          processRunner: tmpfsRunner,
          inspectRootfsEntry: async () => placeholder,
          readRootfsFile: async () =>
            `const FLAG = "${SANDBOX_USER_ENVIRONMENT_BOOTSTRAP_FLAG}"`,
        }),
      ).resolves.toBeUndefined()
    })
  })

  it("refuses a pre-M12 bootstrap that would ignore the mounted file", async () => {
    await withRoot(async (rootDir) => {
      await expect(
        ensureUserEnvironmentCapability({
          rootDir,
          baseRootfsImage: "/rootfs",
          processRunner: tmpfsRunner,
          inspectRootfsEntry: async () => placeholder,
          readRootfsFile: async () => "old bootstrap",
        }),
      ).rejects.toThrow(/does not support user environment delivery/)
    })
  })

  it.each([
    ["missing", null],
    ["a symlink", { ...placeholder, kind: "symlink" as const }],
    ["non-empty", { ...placeholder, size: 3 }],
    ["not root-owned", { ...placeholder, uid: 65534 }],
    ["writable", { ...placeholder, mode: 0o666 }],
  ])("refuses a placeholder that is %s", async (_label, entry) => {
    await withRoot(async (rootDir) => {
      await expect(
        ensureUserEnvironmentCapability({
          rootDir,
          baseRootfsImage: "/rootfs",
          processRunner: tmpfsRunner,
          inspectRootfsEntry: async () => entry,
          readRootfsFile: async () => SANDBOX_USER_ENVIRONMENT_BOOTSTRAP_FLAG,
        }),
      ).rejects.toThrow(/run\/secrets\/user-env placeholder/)
    })
  })

  it("refuses a persistent (non-tmpfs) root", async () => {
    await withRoot(async (rootDir) => {
      await expect(
        ensureUserEnvironmentCapability({
          rootDir,
          baseRootfsImage: "/rootfs",
          processRunner: {
            run: async () => ({
              exitCode: 0,
              timedOut: false,
              stdout: "ext4\n",
              stderr: "",
            }),
          },
          inspectRootfsEntry: async () => placeholder,
          readRootfsFile: async () => SANDBOX_USER_ENVIRONMENT_BOOTSTRAP_FLAG,
        }),
      ).rejects.toThrow()
    })
  })
})

describe("initializeProductionUserEnvironmentRuntime", () => {
  const baseOptions = {
    baseRootfsImage: "/rootfs",
    forbiddenRoots: ["/var/lib/peephole/jobs", "/run/peephole/secrets"],
    orphanReaperMaxAgeMs: 30 * 60_000,
  }

  it("still reaps leftovers at startup while disabled, without the capability gate", async () => {
    const reapAll = vi.fn(async () => [])
    const ensureCapability = vi.fn(async () => undefined)
    const runtime = await initializeProductionUserEnvironmentRuntime(
      {
        ...baseOptions,
        config: { enabled: false, rootDir: "/run/peephole/user-env" },
      },
      {
        ensureCapability,
        createOrphanReaper: () => ({ reap: async () => [], reapAll }),
      },
    )
    expect(runtime).toEqual({ enabled: false })
    expect(reapAll).toHaveBeenCalledOnce()
    expect(ensureCapability).not.toHaveBeenCalled()
  })

  it("proves the capability before reaping and returns one broker when enabled", async () => {
    const events: string[] = []
    const runtime = await initializeProductionUserEnvironmentRuntime(
      {
        ...baseOptions,
        config: { enabled: true, rootDir: "/run/peephole/user-env" },
      },
      {
        ensureCapability: async () => {
          events.push("capability")
        },
        createOrphanReaper: () => ({
          reap: async () => [],
          reapAll: async () => {
            events.push("reapAll")
            return []
          },
        }),
      },
    )
    expect(events).toEqual(["capability", "reapAll"])
    expect(runtime.enabled).toBe(true)
    if (runtime.enabled) {
      expect(runtime.broker).toBeInstanceOf(InMemoryUserEnvironmentBroker)
    }
  })

  it("aborts startup when the capability gate fails", async () => {
    await expect(
      initializeProductionUserEnvironmentRuntime(
        {
          ...baseOptions,
          config: { enabled: true, rootDir: "/run/peephole/user-env" },
        },
        {
          ensureCapability: async () => {
            throw new Error("stale rootfs")
          },
          createOrphanReaper: () => ({
            reap: async () => [],
            reapAll: async () => [],
          }),
        },
      ),
    ).rejects.toThrow("stale rootfs")
  })

  it("refuses a root overlapping another Peephole storage root", async () => {
    await expect(
      initializeProductionUserEnvironmentRuntime({
        ...baseOptions,
        config: { enabled: true, rootDir: "/run/peephole/secrets/user-env" },
      }),
    ).rejects.toThrow("must be separate")
  })
})

describe("composeProductionBackendRuntime user environment seam", () => {
  it("requires the source and filesystem together", () => {
    const common = {
      baseRootfsImage: "/rootfs",
      secretBroker: new InMemoryBackendRuntimeSecretBroker(),
      generatedSecretFilesystem: new TmpfsGeneratedSecretFilesystem(),
      liveRuntimeRegistry: new LiveBackendRuntimeRegistry(),
    }
    const controlPlane = {} as BackendRuntimeControlPlane
    expect(() =>
      composeProductionBackendRuntime(controlPlane, {
        ...common,
        userEnvironmentSource: new InMemoryUserEnvironmentBroker(),
      }),
    ).toThrow("must be configured together")
    expect(() =>
      composeProductionBackendRuntime(controlPlane, {
        ...common,
        userEnvironmentFilesystem: new TmpfsUserEnvironmentFilesystem(),
      }),
    ).toThrow("must be configured together")
    expect(() =>
      composeProductionBackendRuntime(controlPlane, {
        ...common,
        userEnvironmentSource: new InMemoryUserEnvironmentBroker(),
        userEnvironmentFilesystem: new TmpfsUserEnvironmentFilesystem(),
      }),
    ).not.toThrow()
  })
})
