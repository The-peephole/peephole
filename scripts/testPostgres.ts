import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { parseEnv } from "node:util"
import { Pool } from "pg"
import { readPostgresConfig } from "../services/preview-api/postgres/config"

// Uses a disposable schema, never the application's existing tables or queue.
const local = existsSync(".env.local")
  ? parseEnv(readFileSync(".env.local", "utf8"))
  : {}
const connectionString =
  process.env.PEEPHOLE_POSTGRES_TEST_URL ??
  process.env.PEEPHOLE_DATABASE_URL ??
  local.PEEPHOLE_DATABASE_URL
const environment = {
  ...local,
  ...process.env,
  PEEPHOLE_DATABASE_URL: connectionString,
}
const schema = `peephole_test_${randomUUID().replaceAll("-", "")}`

async function main() {
  const database = new Pool(readPostgresConfig(environment).pool)
  let created = false
  try {
    await database.query(`CREATE SCHEMA "${schema}"`)
    created = true
    const url = new URL(connectionString!)
    url.searchParams.set("options", `-c search_path=${schema}`)
    console.log(
      "Running PostgreSQL integration tests in an isolated disposable schema.",
    )
    process.exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "node_modules/vitest/vitest.mjs",
          "run",
          "tests/postgresIntegration.test.ts",
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

main().catch(() => {
  console.error(
    "PostgreSQL integration setup or cleanup failed. Check database connectivity and schema permissions.",
  )
  process.exitCode = 1
})
