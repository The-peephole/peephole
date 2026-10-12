/* global require, process */
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS runs inside the sandbox with no package.json */
// M12 real-gVisor fixture (tests/realUserEnvironmentRuntime.test.ts).
// CommonJS, no dependencies, no egress. Never returns, logs, or writes an
// environment value: /env-check reports presence and a SHA-256 digest only,
// and /exit ends the process for the natural-exit cleanup case.
const http = require("http")
const crypto = require("crypto")

const CHECKED_NAMES = [
  "APP_GREETING",
  "FEATURE_MODE",
  "SESSION_SECRET",
  "DATABASE_URL",
]
const FLAG = "--peephole-require-user-environment"

function describe(name) {
  const value = process.env[name]
  if (typeof value !== "string" || value.length === 0) {
    return { present: false, sha256: null }
  }
  return {
    present: true,
    sha256: crypto.createHash("sha256").update(value, "utf8").digest("hex"),
  }
}

function argvContainsConfiguredValue() {
  return CHECKED_NAMES.some((name) => {
    const value = process.env[name]
    return (
      typeof value === "string" &&
      value.length > 0 &&
      process.argv.some((argument) => argument.includes(value))
    )
  })
}

const server = http.createServer((request, response) => {
  if (request.url === "/env-check") {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(
      JSON.stringify({
        variables: Object.fromEntries(
          CHECKED_NAMES.map((name) => [name, describe(name)]),
        ),
        platform: {
          port: process.env.PORT === "3000",
          host: process.env.HOST === "0.0.0.0",
          nodeEnv: process.env.NODE_ENV === "production",
        },
        argvHasBootstrapFlag: process.argv.includes(FLAG),
        argvContainsConfiguredValue: argvContainsConfiguredValue(),
      }),
    )
    return
  }
  if (request.url === "/exit") {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ exiting: true }), () => process.exit(0))
    return
  }
  response.writeHead(404)
  response.end()
})
server.listen(Number(process.env.PORT), "0.0.0.0")
