import { describe, expect, it } from "vitest"

import { readProductionConfig } from "../services/production/config"

describe("readProductionConfig", () => {
  it("defaults worker concurrency to 1 and paths to /var/lib/peephole/*", () => {
    const config = readProductionConfig({})

    expect(config.workerConcurrency).toBe(1)
    expect(config.baseRootfsImage).toBe("/var/lib/peephole/base-rootfs")
    expect(config.bundlesRootDir).toBe("/var/lib/peephole/jobs")
    expect(config.runscRootDir).toBe("/var/run/peephole/runsc")
    expect(config.artifactStorageDir).toBe("/var/lib/peephole/artifacts")
    expect(config.artifactPort).toBe(8_788)
    expect(config.artifactBaseDomain).toBe("peepholeusercontent.dev")
  })

  it("reads PEEPHOLE_WORKER_CONCURRENCY", () => {
    const config = readProductionConfig({
      PEEPHOLE_WORKER_CONCURRENCY: "3",
    })

    expect(config.workerConcurrency).toBe(3)
  })

  it("rejects a worker concurrency below 1", () => {
    expect(() =>
      readProductionConfig({ PEEPHOLE_WORKER_CONCURRENCY: "0" }),
    ).toThrow(/PEEPHOLE_WORKER_CONCURRENCY/)
  })

  it("rejects a worker concurrency above the sanity ceiling", () => {
    expect(() =>
      readProductionConfig({ PEEPHOLE_WORKER_CONCURRENCY: "17" }),
    ).toThrow(/PEEPHOLE_WORKER_CONCURRENCY/)
  })

  it("rejects a non-integer worker concurrency", () => {
    expect(() =>
      readProductionConfig({ PEEPHOLE_WORKER_CONCURRENCY: "abc" }),
    ).toThrow(/PEEPHOLE_WORKER_CONCURRENCY/)
  })

  it("overrides gvisor paths from the environment", () => {
    const config = readProductionConfig({
      PEEPHOLE_GVISOR_BASE_ROOTFS: "/custom/rootfs",
      PEEPHOLE_GVISOR_BUNDLES_DIR: "/custom/jobs",
      PEEPHOLE_GVISOR_RUNSC_ROOT: "/custom/runsc",
      PEEPHOLE_ARTIFACT_STORAGE_DIR: "/custom/artifacts",
    })

    expect(config.baseRootfsImage).toBe("/custom/rootfs")
    expect(config.bundlesRootDir).toBe("/custom/jobs")
    expect(config.runscRootDir).toBe("/custom/runsc")
    expect(config.artifactStorageDir).toBe("/custom/artifacts")
  })

  it("rejects an out-of-range orphan reaper max age", () => {
    expect(() =>
      readProductionConfig({ PEEPHOLE_GVISOR_ORPHAN_MAX_AGE_MS: "1" }),
    ).toThrow(/PEEPHOLE_GVISOR_ORPHAN_MAX_AGE_MS/)
  })

  it("rejects an out-of-range maintenance interval", () => {
    expect(() =>
      readProductionConfig({ PEEPHOLE_MAINTENANCE_INTERVAL_MS: "1" }),
    ).toThrow(/PEEPHOLE_MAINTENANCE_INTERVAL_MS/)
  })

  it("reads the artifact listener port and base domain from the environment", () => {
    const config = readProductionConfig({
      PEEPHOLE_ARTIFACT_PORT: "9999",
      PEEPHOLE_ARTIFACT_BASE_DOMAIN: "Preview.Example.com",
    })

    expect(config.artifactPort).toBe(9_999)
    // Normalized to lowercase -- Host header matching is case-insensitive
    // but the on-disk directory name it maps to is not.
    expect(config.artifactBaseDomain).toBe("preview.example.com")
  })

  it("rejects an out-of-range artifact port", () => {
    expect(() => readProductionConfig({ PEEPHOLE_ARTIFACT_PORT: "0" })).toThrow(
      /PEEPHOLE_ARTIFACT_PORT/,
    )
    expect(() =>
      readProductionConfig({ PEEPHOLE_ARTIFACT_PORT: "70000" }),
    ).toThrow(/PEEPHOLE_ARTIFACT_PORT/)
  })

  it("rejects an artifact base domain with no dot (e.g. a bare label)", () => {
    expect(() =>
      readProductionConfig({ PEEPHOLE_ARTIFACT_BASE_DOMAIN: "notadomain" }),
    ).toThrow(/PEEPHOLE_ARTIFACT_BASE_DOMAIN/)
  })

  it("rejects localhost as an artifact base domain", () => {
    expect(() =>
      readProductionConfig({ PEEPHOLE_ARTIFACT_BASE_DOMAIN: "localhost" }),
    ).toThrow(/PEEPHOLE_ARTIFACT_BASE_DOMAIN/)
  })

  it("rejects a malformed artifact base domain", () => {
    expect(() =>
      readProductionConfig({
        PEEPHOLE_ARTIFACT_BASE_DOMAIN: "-not.valid",
      }),
    ).toThrow(/PEEPHOLE_ARTIFACT_BASE_DOMAIN/)
  })

  it("readProductionConfig never exposes an artifact host bind-address option", () => {
    // The artifact listener must only ever bind loopback -- there is no
    // config field for its host/bind-address at all, so no environment
    // variable can misconfigure it to 0.0.0.0.
    const config = readProductionConfig({})
    expect("artifactHost" in config).toBe(false)
    expect("artifactBindAddress" in config).toBe(false)
  })
})
