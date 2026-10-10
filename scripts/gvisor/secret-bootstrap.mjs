import { spawn } from "node:child_process"
import { Buffer } from "node:buffer"
import { readFile } from "node:fs/promises"
import process from "node:process"
import { fileURLToPath } from "node:url"

const SECRET_FILE = "/run/secrets/env"
// A structurally separate fixed path from SECRET_FILE above -- never parsed
// with the NAME=value grammar below, and DATABASE_URL is never added to
// ALLOWED_NAMES. See docs/TEMPORARY_DATABASES.md section 15.
const DATABASE_CREDENTIAL_FILE = "/run/secrets/database-url"
// M12 (D-035): a third, structurally separate fixed path holding one JSON
// object of user-provided, non-sensitive configuration. Never parsed with
// the NAME=value grammar above or the raw-URL format above; neither of
// those two files changes meaning. See docs/USER_PROVIDED_ENVIRONMENT.md.
const USER_ENVIRONMENT_FILE = "/run/secrets/user-env"
// The host passes this fixed first argument iff it mounted a user-env file
// (backendRuntimeProcess.ts). A pre-M12 bootstrap forwards it to Node,
// which rejects the unknown option -- a stale rootfs fails closed.
const USER_ENVIRONMENT_FLAG = "--peephole-require-user-environment"
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
const MAX_DATABASE_URL_BYTES = 4096
const MAX_USER_ENVIRONMENT_FILE_BYTES = 64 * 1024
const MAX_USER_ENVIRONMENT_ENTRIES = 16
const MAX_USER_ENVIRONMENT_VALUE_BYTES = 1024
const MAX_USER_ENVIRONMENT_TOTAL_BYTES = 8192
// Independent copy of core/userEnvironment/userEnvironmentPolicy.ts's
// structural name rules -- this file runs inside the sandbox and imports
// nothing from the host codebase. Membership in the server-derived plan was
// already enforced host-side; this is the last, defense-in-depth check.
const USER_ENVIRONMENT_FORBIDDEN_NAMES = new Set([
  "PORT",
  "HOST",
  "NODE_ENV",
  "DATABASE_URL",
  "JWT_SECRET",
  "SESSION_SECRET",
  "COOKIE_SECRET",
  "CSRF_SECRET",
  "PATH",
  "HOME",
  "SHELL",
  "ENV",
  "BASH_ENV",
  "IFS",
  "PS4",
  "PROMPT_COMMAND",
  "USER",
  "LOGNAME",
  "PWD",
  "OLDPWD",
  "HOSTNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "GCONV_PATH",
  "LOCPATH",
  "HOSTALIASES",
  "RES_OPTIONS",
  "LOCALDOMAIN",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "FTP_PROXY",
])
const USER_ENVIRONMENT_FORBIDDEN_PREFIXES = [
  "NODE_",
  "NPM_",
  "LD_",
  "DYLD_",
  "PEEPHOLE_",
  "UV_",
  "V8_",
  "OPENSSL_",
  "SSL_",
  "GLIBC_",
  "MALLOC_",
  "COREPACK_",
  "YARN_",
  "PNPM_",
  "BUN_",
  "DENO_",
  "VITE_",
  "NEXT_PUBLIC_",
  "REACT_APP_",
  "NUXT_PUBLIC_",
  "EXPO_PUBLIC_",
  "GATSBY_",
  "PUBLIC_",
]

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

/** The database credential file's entire content is the raw URL, never a
 * `NAME=value` line -- this never shares NAME_PATTERN/VALUE_PATTERN parsing
 * with parseSecretMaterial above. At most one trailing newline is stripped;
 * anything else (empty, embedded newline) fails closed. `MAX_DATABASE_URL_BYTES`
 * bounds the URL VALUE itself (post trailing-newline-strip), matching the
 * writer's own bound in databaseCredentialFilesystem.ts -- so a value that is
 * exactly at the limit produces a framed file one byte larger (the trailing
 * `\n`) that is still accepted here, rather than being rejected on the framed
 * byte count. */
export function parseDatabaseCredentialMaterial(contents) {
  if (typeof contents !== "string") {
    throw new Error("Malformed database credential material.")
  }
  const trimmed = contents.endsWith("\n") ? contents.slice(0, -1) : contents
  if (trimmed.length === 0 || trimmed.includes("\n")) {
    throw new Error("Malformed database credential material.")
  }
  if (Buffer.byteLength(trimmed, "utf8") > MAX_DATABASE_URL_BYTES) {
    throw new Error("Malformed database credential material.")
  }
  return trimmed
}

function isAllowedUserEnvironmentCodePoint(codePoint) {
  return !(
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0xfeff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  )
}

function isValidUserEnvironmentValue(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_USER_ENVIRONMENT_VALUE_BYTES
  ) {
    return false
  }
  // for...of iterates code points, so a well-formed surrogate pair is one
  // astral code point and only a lone surrogate reaches the D800-DFFF test.
  for (const character of value) {
    if (!isAllowedUserEnvironmentCodePoint(character.codePointAt(0))) {
      return false
    }
  }
  return true
}

function isValidUserEnvironmentName(name) {
  return (
    NAME_PATTERN.test(name) &&
    !USER_ENVIRONMENT_FORBIDDEN_NAMES.has(name) &&
    !ALLOWED_NAMES.has(name) &&
    !RESERVED_NAMES.some((pattern) => pattern.test(name)) &&
    !USER_ENVIRONMENT_FORBIDDEN_PREFIXES.some((prefix) =>
      name.startsWith(prefix),
    )
  )
}

/** The whole file is one JSON object plus exactly one trailing newline. */
export function parseUserEnvironmentMaterial(contents) {
  if (
    typeof contents !== "string" ||
    Buffer.byteLength(contents, "utf8") > MAX_USER_ENVIRONMENT_FILE_BYTES ||
    !contents.endsWith("\n")
  ) {
    throw new Error("Malformed user environment material.")
  }
  // The host writer emits exactly one compact JSON object on one line
  // (JSON.stringify escapes every raw newline), so anything else -- extra
  // lines, surrounding whitespace -- is not material this host produced.
  const body = contents.slice(0, -1)
  if (body.includes("\n") || !body.startsWith("{") || !body.endsWith("}")) {
    throw new Error("Malformed user environment material.")
  }
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error("Malformed user environment material.")
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    throw new Error("Malformed user environment material.")
  }
  const names = Object.keys(parsed)
  if (names.length === 0 || names.length > MAX_USER_ENVIRONMENT_ENTRIES) {
    throw new Error("Malformed user environment material.")
  }
  const environment = Object.create(null)
  let totalBytes = 0
  for (const name of names) {
    const value = parsed[name]
    if (
      !isValidUserEnvironmentName(name) ||
      !isValidUserEnvironmentValue(value)
    ) {
      throw new Error("Malformed user environment material.")
    }
    totalBytes += Buffer.byteLength(value, "utf8")
    environment[name] = value
  }
  if (totalBytes > MAX_USER_ENVIRONMENT_TOTAL_BYTES) {
    throw new Error("Malformed user environment material.")
  }
  return environment
}

async function readOptionalFile(filePath) {
  try {
    return await readFile(filePath, "utf8")
  } catch (error) {
    if (error && error.code === "ENOENT") return null
    throw error
  }
}

export async function runSecretBootstrap({
  secretFile = SECRET_FILE,
  databaseCredentialFile = DATABASE_CREDENTIAL_FILE,
  userEnvironmentFile = USER_ENVIRONMENT_FILE,
  nodeBinary = NODE_BINARY,
  childArgs: requestedChildArgs = process.argv.slice(2),
  baseEnvironment = process.env,
  spawnChild = spawn,
} = {}) {
  const requiresUserEnvironment =
    requestedChildArgs[0] === USER_ENVIRONMENT_FLAG
  const childArgs = requiresUserEnvironment
    ? requestedChildArgs.slice(1)
    : requestedChildArgs
  if (childArgs.length === 0) {
    throw new Error("Backend entrypoint is missing.")
  }

  // A zero-length read is treated the same as an absent file: when only one
  // of the two credentials is mounted for this run, the OTHER fixed path
  // still resolves to the base rootfs's own empty placeholder (never a real,
  // legitimately-empty credential -- both writers always emit at least one
  // non-empty line/URL) rather than ENOENT, since it is baked into the
  // image itself rather than created at mount time. See
  // build-base-rootfs.sh's own comment on why that placeholder must be
  // world-readable.
  let secrets = {}
  const generatedContents = await readOptionalFile(secretFile)
  if (generatedContents !== null && generatedContents.length > 0) {
    secrets = parseSecretMaterial(generatedContents)
  }

  let databaseEnvironment = {}
  const databaseContents = await readOptionalFile(databaseCredentialFile)
  if (databaseContents !== null && databaseContents.length > 0) {
    databaseEnvironment = {
      DATABASE_URL: parseDatabaseCredentialMaterial(databaseContents),
    }
  }

  // Required iff flagged: a flagged run never starts without its values,
  // and an unflagged run never accepts an unexpected non-empty mount.
  let userEnvironment = {}
  const userContents = await readOptionalFile(userEnvironmentFile)
  const hasUserContents = userContents !== null && userContents.length > 0
  if (requiresUserEnvironment !== hasUserContents) {
    throw new Error("Malformed user environment material.")
  }
  if (hasUserContents) {
    userEnvironment = parseUserEnvironmentMaterial(userContents)
    for (const name of Object.keys(userEnvironment)) {
      if (
        Object.hasOwn(baseEnvironment, name) ||
        Object.hasOwn(secrets, name) ||
        Object.hasOwn(databaseEnvironment, name)
      ) {
        throw new Error("Malformed user environment material.")
      }
    }
  }

  const child = spawnChild(nodeBinary, childArgs, {
    env: {
      ...baseEnvironment,
      ...userEnvironment,
      ...secrets,
      ...databaseEnvironment,
    },
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
