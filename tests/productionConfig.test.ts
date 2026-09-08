import { describe, expect, it } from "vitest"

import { readProductionConfig } from "../services/production/config"

describe("readProductionConfig", () => {
  it("defaults worker concurrency to 1 and paths to /var/lib/peephole/*", () => {
    const config = readProductionConfig({})

    expect(config.trustedRegistrableDomain).toBe("peephole.dev")
    expect(config.trustedAppOrigin).toBe("https://app.peephole.dev")
    expect(config.workerConcurrency).toBe(1)
    expect(config.baseRootfsImage).toBe("/var/lib/peephole/base-rootfs")
    expect(config.bundlesRootDir).toBe("/var/lib/peephole/jobs")
    expect(config.runscRootDir).toBe("/var/run/peephole/runsc")
    expect(config.artifactStorageDir).toBe("/var/lib/peephole/artifacts")
    expect(config.artifactPort).toBe(8_788)
    expect(config.artifactTlsAskPort).toBe(8_790)
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

  it.each(["peephole.dev", "preview.peephole.dev", "foo.bar.peephole.dev"])(
    "rejects artifact base domain %s because it shares the trusted registrable domain",
    (artifactBaseDomain) => {
      expect(() =>
        readProductionConfig({
          PEEPHOLE_ARTIFACT_BASE_DOMAIN: artifactBaseDomain,
        }),
      ).toThrow(
        "PEEPHOLE_ARTIFACT_BASE_DOMAIN must not share the trusted peephole.dev registrable domain.",
      )
    },
  )

  it.each(["peepholeusercontent.dev", "notpeephole.dev"])(
    "allows separate artifact base domain %s",
    (artifactBaseDomain) => {
      expect(
        readProductionConfig({
          PEEPHOLE_ARTIFACT_BASE_DOMAIN: artifactBaseDomain,
        }).artifactBaseDomain,
      ).toBe(artifactBaseDomain)
    },
  )

  it("readProductionConfig never exposes an artifact host bind-address option", () => {
    // The artifact listener must only ever bind loopback -- there is no
    // config field for its host/bind-address at all, so no environment
    // variable can misconfigure it to 0.0.0.0.
    const config = readProductionConfig({})
    expect("artifactHost" in config).toBe(false)
    expect("artifactBindAddress" in config).toBe(false)
  })
})

describe("TLS ask config", () => {
  it("reads the ask port and permits the deployment nip.io domain", () => {
    const config = readProductionConfig({
      PEEPHOLE_ARTIFACT_TLS_ASK_PORT: "9876",
      PEEPHOLE_ARTIFACT_BASE_DOMAIN: "3.34.44.114.nip.io",
      PEEPHOLE_ARTIFACT_TLS_ASK_HOST: "0.0.0.0",
    })
    expect(config.artifactTlsAskPort).toBe(9876)
    expect(config.artifactBaseDomain).toBe("3.34.44.114.nip.io")
    expect("artifactTlsAskHost" in config).toBe(false)
    expect("artifactTlsAskBindAddress" in config).toBe(false)
  })

  it.each(["0", "65536", "-1", "1.5", "abc"])(
    "rejects invalid ask port %s",
    (port) => {
      expect(() =>
        readProductionConfig({ PEEPHOLE_ARTIFACT_TLS_ASK_PORT: port }),
      ).toThrow(/PEEPHOLE_ARTIFACT_TLS_ASK_PORT/)
    },
  )

  it.each([
    { PEEPHOLE_ARTIFACT_TLS_ASK_PORT: "8788" },
    { PEEPHOLE_ARTIFACT_PORT: "8790" },
    { PEEPHOLE_ARTIFACT_PORT: "9999", PEEPHOLE_ARTIFACT_TLS_ASK_PORT: "9999" },
  ])("rejects listener port collisions", (environment) => {
    expect(() => readProductionConfig(environment)).toThrow(/must differ/)
  })
})

describe("trusted production domains", () => {
  it("accepts and normalizes the free deployment", () => {
    const config = readProductionConfig({
      PEEPHOLE_TRUSTED_REGISTRABLE_DOMAIN: "SSLIP.IO",
      PEEPHOLE_TRUSTED_APP_ORIGIN: "https://app.3.34.33.24.sslip.io",
      PEEPHOLE_ARTIFACT_BASE_DOMAIN: "3.34.33.24.nip.io",
    })
    expect(config.trustedRegistrableDomain).toBe("sslip.io")
    expect(config.trustedAppOrigin).toBe("https://app.3.34.33.24.sslip.io")
    expect(config.artifactBaseDomain).toBe("3.34.33.24.nip.io")
  })

  it.each([
    ["peephole.dev", "peephole.dev"],
    ["peephole.dev", "preview.peephole.dev"],
    ["preview.peephole.dev", "peephole.dev"],
    ["sslip.io", "foo.sslip.io"],
    ["foo.sslip.io", "sslip.io"],
  ])("rejects overlapping trees %s / %s", (trusted, artifact) => {
    expect(() =>
      readProductionConfig({
        PEEPHOLE_TRUSTED_REGISTRABLE_DOMAIN: trusted,
        PEEPHOLE_TRUSTED_APP_ORIGIN: `https://${trusted}`,
        PEEPHOLE_ARTIFACT_BASE_DOMAIN: artifact,
      }),
    ).toThrow(/PEEPHOLE_ARTIFACT_BASE_DOMAIN must not share/)
  })

  it.each([
    "",
    " ",
    "localhost",
    "app.localhost",
    "sslip.io:443",
    "https://sslip.io",
    "sslip.io/path",
    "sslip.io?x",
    "sslip.io#x",
    "foo..io",
    ".sslip.io",
    "sslip.io.",
    "-foo.io",
    "foo-.io",
    "foo_bar.io",
    "127.0.0.1",
    `${"a".repeat(64)}.io`,
    `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}`,
  ])("rejects malformed trusted domain %s", (domain) => {
    expect(() =>
      readProductionConfig({
        PEEPHOLE_TRUSTED_REGISTRABLE_DOMAIN: domain,
      }),
    ).toThrow(/PEEPHOLE_TRUSTED_REGISTRABLE_DOMAIN/)
  })

  it.each([
    "",
    " ",
    "http://app.sslip.io",
    "https://app.sslip.io:8443",
    "https://app.sslip.io:443",
    "https://user:pass@app.sslip.io",
    "https://app.sslip.io/path",
    "https://app.sslip.io?query=1",
    "https://app.sslip.io#fragment",
    "https://app.sslip.io?",
    "https://app.sslip.io#",
    "https://app.sslip.io/..",
    "chrome-extension://abc",
    "javascript:alert(1)",
    "https://app.peephole.dev",
    "https://notsslip.io",
    "https://sslip.io.evil.com",
    "https://app.sslip.io;script-src *",
    "https://app.sslip.io\n",
    "https://app..sslip.io",
  ])("rejects unsafe or foreign origin %s", (origin) => {
    expect(() =>
      readProductionConfig({
        PEEPHOLE_TRUSTED_REGISTRABLE_DOMAIN: "sslip.io",
        PEEPHOLE_TRUSTED_APP_ORIGIN: origin,
      }),
    ).toThrow(/PEEPHOLE_TRUSTED_APP_ORIGIN/)
  })

  it("accepts the trusted root and normalizes a root slash and hostname case", () => {
    expect(
      readProductionConfig({
        PEEPHOLE_TRUSTED_REGISTRABLE_DOMAIN: "sslip.io",
        PEEPHOLE_TRUSTED_APP_ORIGIN: "https://SSLIP.IO/",
      }).trustedAppOrigin,
    ).toBe("https://sslip.io")
  })
})
