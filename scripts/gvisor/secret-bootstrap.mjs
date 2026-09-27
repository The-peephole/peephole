import { spawn } from "node:child_process"
import { Buffer } from "node:buffer"
import { readFile } from "node:fs/promises"
import process from "node:process"
import { fileURLToPath } from "node:url"

const SECRET_FILE = "/run/secrets/env"
const NODE_BINARY = "/usr/local/bin/node"
const ALLOWED_NAMES = new Set([
  "JWT_SECRET",
  "SESSION_SECRET",
  "COOKIE_SECRET",
  "CSRF_SECRET",
])
const RESERVED_NAMES = [
  /^NODE_OPTIONS$/,
  /^NODE_PATH$/,
  /^PATH$/,
  /^LD_PRELOAD$/,
  /^LD_LIBRARY_PATH$/,
  /^HOME$/,
  /^SHELL$/,
  /^ENV$/,
  /^BASH_ENV$/,
  /^NPM_CONFIG_/i,
  /^PEEPHOLE_/,
]
const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/
const VALUE_PATTERN = /^[A-Za-z0-9_-]+$/
const MAX_FILE_BYTES = 16 * 1024
const MAX_VALUE_BYTES = 4096

export function parseSecretMaterial(contents) {
  if (
    typeof contents !== "string" ||
    Buffer.byteLength(contents, "utf8") > MAX_FILE_BYTES ||
    !contents.endsWith("\n")
  ) {
    throw new Error("Malformed generated-secret material.")
  }

  const environment = Object.create(null)
  const lines = contents.slice(0, -1).split("\n")
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    throw new Error("Malformed generated-secret material.")
  }
  for (const line of lines) {
    const separator = line.indexOf("=")
    if (separator <= 0 || separator !== line.lastIndexOf("=")) {
      throw new Error("Malformed generated-secret material.")
    }
    const name = line.slice(0, separator)
    const value = line.slice(separator + 1)
    if (
      !NAME_PATTERN.test(name) ||
      !ALLOWED_NAMES.has(name) ||
      RESERVED_NAMES.some((pattern) => pattern.test(name)) ||
      Object.hasOwn(environment, name) ||
      !VALUE_PATTERN.test(value) ||
      Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES
    ) {
      throw new Error("Malformed generated-secret material.")
    }
    environment[name] = value
  }
  return environment
}

export async function runSecretBootstrap({
  secretFile = SECRET_FILE,
  nodeBinary = NODE_BINARY,
  childArgs = process.argv.slice(2),
  baseEnvironment = process.env,
  spawnChild = spawn,
} = {}) {
  if (childArgs.length === 0) {
    throw new Error("Backend entrypoint is missing.")
  }
  const contents = await readFile(secretFile, "utf8")
  const secrets = parseSecretMaterial(contents)
  const child = spawnChild(nodeBinary, childArgs, {
    env: { ...baseEnvironment, ...secrets },
    shell: false,
    stdio: "inherit",
  })

  const forwardedSignals = ["SIGTERM", "SIGINT", "SIGHUP"]
  const handlers = new Map()
  for (const signal of forwardedSignals) {
    const handler = () => {
      if (!child.killed) child.kill(signal)
    }
    handlers.set(signal, handler)
    process.on(signal, handler)
  }

  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }))
    })
  } finally {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler)
    }
  }
}

async function main() {
  try {
    const result = await runSecretBootstrap()
    if (result.signal) {
      process.kill(process.pid, result.signal)
      return
    }
    process.exitCode = result.exitCode ?? 1
  } catch {
    // Structural only: never include parser errors, file contents, argv, or
    // child output in Peephole-owned diagnostics.
    process.stderr.write("Peephole secret bootstrap failed.\n")
    process.exitCode = 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
