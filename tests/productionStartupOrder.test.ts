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
      "const generatedSecrets = await initializeProductionGeneratedSecretRuntime",
      "const temporaryDatabases = await initializeProductionTemporaryDatabaseRuntime",
      "const worker = composeProductionWorker",
      "...temporaryDatabaseBackendDependencies(temporaryDatabases)",
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

  it("includes bounded generated-secret reconciliation in maintenance", async () => {
    const source = await readFile(
      path.resolve("services/production/server.ts"),
      "utf8",
    )
    const maintenanceStart = source.indexOf("const maintain = () =>")
    const maintenance = source.slice(
      maintenanceStart,
      source.indexOf("maintain()", maintenanceStart),
    )

    expect(maintenance).toContain("generatedSecrets.orphanReaper.reap()")
    expect(maintenance).toContain("cleanup failed; will retry")
  })

  it("adds temporary-database maintenance inside the same error-reporting sweep", async () => {
    const source = await readFile(
      path.resolve("services/production/server.ts"),
      "utf8",
    )
    const maintenanceStart = source.indexOf("const maintain = () =>")
    const maintenance = source.slice(
      maintenanceStart,
      source.indexOf("maintain()", maintenanceStart),
    )
    const tasks = maintenance.indexOf(
      "...temporaryDatabaseMaintenanceTasks(temporaryDatabases)",
    )

    expect(tasks).toBeGreaterThan(maintenance.indexOf("Promise.all(["))
    expect(tasks).toBeLessThan(
      maintenance.indexOf("cleanup failed; will retry"),
    )
  })

  it("never catches a temporary-database startup failure", async () => {
    const source = await readFile(
      path.resolve("services/production/server.ts"),
      "utf8",
    )
    const start = source.indexOf(
      "const temporaryDatabases = await initializeProductionTemporaryDatabaseRuntime",
    )
    const statement = source.slice(start, source.indexOf(")\n", start))

    expect(statement).not.toMatch(/\.catch\(|try\s*\{/)
  })

  it("runs the temporary-database gate unconditionally so a disabled flag cannot skip ownership reconciliation", async () => {
    const source = await readFile(
      path.resolve("services/production/server.ts"),
      "utf8",
    )

    // The initializer itself decides disabled behavior (including refusing
    // startup on outstanding ownership); server.ts must never branch on it.
    expect(source).not.toContain("temporaryDatabases.enabled")
    expect(
      source.match(/initializeProductionTemporaryDatabaseRuntime\(/g),
    ).toHaveLength(1)
    const call = source.indexOf(
      "const temporaryDatabases = await initializeProductionTemporaryDatabaseRuntime",
    )
    const mainStart = source.indexOf("async function main()")
    const preceding = source.slice(mainStart, call)
    // Top-level statement of main(): no enclosing block opened before it.
    expect(preceding.split("{").length).toBe(preceding.split("}").length + 1)
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
      "await temporaryDatabases?.close()",
      "await database.close()",
    ].map((token) => {
      const index = shutdown.indexOf(token)
      expect(index, `missing shutdown stage: ${token}`).toBeGreaterThan(-1)
      return index
    })
    expect(order).toEqual([...order].sort((left, right) => left - right))
  })
})
