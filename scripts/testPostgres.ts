import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { readPostgresConfig } from "../services/preview-api/postgres/config"

const connectionString = process.env.PEEPHOLE_POSTGRES_TEST_URL
const clusterGlobalAllowed =
  process.env.PEEPHOLE_POSTGRES_ALLOW_CLUSTER_GLOBAL === "1"

async function main(explicitTestUrl: string) {
  // Control-plane tables remain isolated in this disposable schema. The M11
  // suite also creates uniquely named cluster-global ROLE/DATABASE objects,
  // which are allowed only on an explicitly opted-in disposable test cluster.
  const schema = `peephole_test_${randomUUID().replaceAll("-", "")}`
  const environment = {
    ...process.env,
    PEEPHOLE_DATABASE_URL: explicitTestUrl,
  }
  const database = new Pool(readPostgresConfig(environment).pool)
  let created = false
  try {
    await database.query(`CREATE SCHEMA "${schema}"`)
    created = true
    const url = new URL(explicitTestUrl)
    url.searchParams.set("options", `-c search_path=${schema}`)
    console.log(
      "Running PostgreSQL integration tests on an explicitly opted-in disposable cluster with an isolated control-plane schema.",
    )
    process.exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "node_modules/vitest/vitest.mjs",
          "run",
          "--no-file-parallelism",
          "tests/postgresIntegration.test.ts",
          "tests/postgresFullStackPreview.test.ts",
          "tests/postgresTemporaryDatabase.test.ts",
          "tests/postgresTemporaryDatabaseReaper.test.ts",
        ],
        {
          stdio: "inherit",
          windowsHide: true,
          env: { ...environment, PEEPHOLE_POSTGRES_TEST_URL: url.toString() },
        },
      )
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
  } finally {
    // Only the schema generated and created by this invocation can be dropped.
    if (created && /^peephole_test_[a-f0-9]{32}$/.test(schema)) {
      await database.query(`DROP SCHEMA "${schema}" CASCADE`)
      console.log("Removed the disposable test schema.")
    }
    await database.end()
  }
}

if (!connectionString || !clusterGlobalAllowed) {
  console.error(
    "PostgreSQL integration tests create disposable cluster-global roles and databases. Set an explicit PEEPHOLE_POSTGRES_TEST_URL and PEEPHOLE_POSTGRES_ALLOW_CLUSTER_GLOBAL=1 for a dedicated test cluster.",
  )
  process.exitCode = 1
} else {
  void main(connectionString).catch(() => {
    console.error(
      "PostgreSQL integration setup or cleanup failed. Check dedicated test-cluster connectivity and permissions.",
    )
    process.exitCode = 1
  })
}
