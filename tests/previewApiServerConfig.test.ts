import { describe, expect, it } from "vitest"

import { readPreviewApiServerConfig } from "../services/preview-api/serverConfig"

describe("preview API server configuration", () => {
  it("uses bounded production-friendly defaults", () => {
    expect(readPreviewApiServerConfig({})).toEqual({
      host: "0.0.0.0",
      port: 8_787,
      maxBodyBytes: 16 * 1024,
      requestTimeoutMs: 15_000,
    })
  })

  it("reads explicit deployment values", () => {
    expect(
      readPreviewApiServerConfig({
        PEEPHOLE_API_HOST: "127.0.0.1",
        PEEPHOLE_API_PORT: "9000",
        PEEPHOLE_API_MAX_BODY_BYTES: "8192",
        PEEPHOLE_API_REQUEST_TIMEOUT_MS: "10000",
      }),
    ).toEqual({
      host: "127.0.0.1",
      port: 9_000,
      maxBodyBytes: 8_192,
      requestTimeoutMs: 10_000,
    })
  })

  it("rejects invalid or unsafe values", () => {
    expect(() =>
      readPreviewApiServerConfig({ PEEPHOLE_API_PORT: "0" }),
    ).toThrow("between 1 and 65535")
    expect(() =>
      readPreviewApiServerConfig({ PEEPHOLE_API_MAX_BODY_BYTES: "2000000" }),
    ).toThrow("between 1 and 1048576")
    expect(() =>
      readPreviewApiServerConfig({ PEEPHOLE_API_HOST: "http://localhost" }),
    ).toThrow("invalid")
  })
})
