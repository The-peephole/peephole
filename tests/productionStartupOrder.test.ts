import { readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

describe("production startup safety gates", () => {
  it("completes disk then network reconciliation before listeners and workers", async () => {
    const source = await readFile(
      path.resolve("services/production/server.ts"),
      "utf8",
    )
    const order = [
      "await ensureProductionPreflight",
      "await applyPostgresMigrations",
      "await orphanReaper.reapAll()",
      "await networkOrphanReaper.reapAll()",
      "await ensureSandboxDiskCapability",
      "await ensureProductionDiskLayout",
      "await artifactHost.listen()",
      "await startNodePreviewApi",
      "const workerLoops =",
    ].map((token) => {
      const index = source.indexOf(token)
      expect(index, `missing startup stage: ${token}`).toBeGreaterThan(-1)
      return index
    })

    expect(order).toEqual([...order].sort((left, right) => left - right))
  })
})
