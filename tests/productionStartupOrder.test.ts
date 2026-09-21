import { readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

describe("production startup safety gates", () => {
  it("reconciles physical and durable state before listeners, then starts child workers before full-stack", async () => {
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
      "await new FullStackPreviewStartupReconciler",
      "await routing.artifactHost.listen()",
      "await routing.tlsAskServer.listen()",
      "await startNodePreviewApi",
      "const workerLoops =",
      "const backendWorkerLoop =",
      "const fullStackWorkerLoop =",
    ].map((token) => {
      const index = source.indexOf(token)
      expect(index, `missing startup stage: ${token}`).toBeGreaterThan(-1)
      return index
    })

    expect(order).toEqual([...order].sort((left, right) => left - right))
  })

  it("shuts down lifecycle ownership before backend and static workers", async () => {
    const source = await readFile(
      path.resolve("services/production/server.ts"),
      "utf8",
    )
    const shutdownStart = source.indexOf("const shutdown = async")
    const shutdown = source.slice(shutdownStart)
    const order = [
      "fullStackWorkerController.abort()",
      "await fullStackWorkerDone",
      "backendWorkerController.abort()",
      "await backendWorkerDone",
      "staticWorkerController.abort()",
      "await workerLoopsDone",
      "await api.stop()",
      "await routing.tlsAskServer.close()",
      "await routing.artifactHost.close()",
      "await database.close()",
    ].map((token) => {
      const index = shutdown.indexOf(token)
      expect(index, `missing shutdown stage: ${token}`).toBeGreaterThan(-1)
      return index
    })
    expect(order).toEqual([...order].sort((left, right) => left - right))
  })
})
