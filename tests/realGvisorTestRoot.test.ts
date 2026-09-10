import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createRealGvisorTestDirectory } from "./support/realGvisorTestRoot"

describe("createRealGvisorTestDirectory", () => {
  let fixtureRoot: string
  let testRoot: string
  let productionRoot: string

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "peephole-real-root-"))
    testRoot = path.join(fixtureRoot, "test-runs")
    productionRoot = path.join(fixtureRoot, "jobs")
    await mkdir(testRoot)
    await mkdir(productionRoot)
  })

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true })
  })

  it("creates collision-free children below the configured test-only root", async () => {
    const sentinel = path.join(testRoot, "operator-owned")
    await writeFile(sentinel, "keep")
    const environment = {
      PEEPHOLE_REAL_GVISOR_TEST_ROOT: testRoot,
      PEEPHOLE_GVISOR_BUNDLES_DIR: productionRoot,
    }

    const [first, second] = await Promise.all([
      createRealGvisorTestDirectory("peephole-suite-", environment),
      createRealGvisorTestDirectory("peephole-suite-", environment),
    ])

    expect(path.dirname(first)).toBe(testRoot)
    expect(path.dirname(second)).toBe(testRoot)
    expect(first).not.toBe(second)
    await rm(first, { recursive: true })
    await rm(second, { recursive: true })
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep")
  })

  it.each([
    ["the production root itself", (root: string) => path.join(root, "jobs")],
    ["a parent of the production root", (root: string) => root],
  ])("rejects %s as the test root", async (_label, selectTestRoot) => {
    await expect(
      createRealGvisorTestDirectory("peephole-suite-", {
        PEEPHOLE_REAL_GVISOR_TEST_ROOT: selectTestRoot(fixtureRoot),
        PEEPHOLE_GVISOR_BUNDLES_DIR: productionRoot,
      }),
    ).rejects.toThrow(/dedicated directory/)
  })

  it("falls back to the OS temp directory when no test root is configured", async () => {
    const child = await createRealGvisorTestDirectory("peephole-fallback-", {})
    try {
      expect(path.resolve(path.dirname(child))).toBe(path.resolve(os.tmpdir()))
    } finally {
      await rm(child, { recursive: true })
    }
  })
})
