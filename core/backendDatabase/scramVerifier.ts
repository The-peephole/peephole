import { createHash, createHmac, pbkdf2Sync } from "node:crypto"

const SCRAM_KEY_BYTES = 32
const MAX_PBKDF2_ITERATIONS = 2_147_483_647

export function createPostgresScramSha256Verifier(
  password: string,
  salt: Uint8Array,
  iterations: number,
): string {
  if (!password || !/^[A-Za-z0-9_-]+$/.test(password)) {
    throw new Error("SCRAM password must use Peephole's safe ASCII grammar.")
  }
  if (!(salt instanceof Uint8Array) || salt.length === 0) {
    throw new Error("SCRAM salt must be non-empty.")
  }
  if (
    !Number.isSafeInteger(iterations) ||
    iterations < 1 ||
    iterations > MAX_PBKDF2_ITERATIONS
  ) {
    throw new Error("SCRAM iteration count must be a positive integer.")
  }

  const saltedPassword = pbkdf2Sync(
    password,
    salt,
    iterations,
    SCRAM_KEY_BYTES,
    "sha256",
  )
  const clientKey = createHmac("sha256", saltedPassword)
    .update("Client Key", "utf8")
    .digest()
  const storedKey = createHash("sha256").update(clientKey).digest()
  const serverKey = createHmac("sha256", saltedPassword)
    .update("Server Key", "utf8")
    .digest()

  const verifier =
    `SCRAM-SHA-256$${iterations}:${Buffer.from(salt).toString("base64")}` +
    `$${storedKey.toString("base64")}:${serverKey.toString("base64")}`
  validatePostgresScramSha256Verifier(verifier)
  return verifier
}

export function validatePostgresScramSha256Verifier(value: unknown): string {
  if (typeof value !== "string") throw invalidVerifier()
  const match = value.match(
    /^SCRAM-SHA-256\$([1-9]\d*):([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2}):([A-Za-z0-9+/]+={0,2})$/,
  )
  if (!match) throw invalidVerifier()

  const iterations = Number(match[1])
  const salt = decodeCanonicalBase64(match[2]!)
  const storedKey = decodeCanonicalBase64(match[3]!)
  const serverKey = decodeCanonicalBase64(match[4]!)
  if (
    !Number.isSafeInteger(iterations) ||
    iterations < 1 ||
    iterations > MAX_PBKDF2_ITERATIONS ||
    salt.length === 0 ||
    storedKey.length !== SCRAM_KEY_BYTES ||
    serverKey.length !== SCRAM_KEY_BYTES
  ) {
    throw invalidVerifier()
  }
  return value
}

function decodeCanonicalBase64(value: string): Buffer {
  const decoded = Buffer.from(value, "base64")
  if (decoded.toString("base64") !== value) throw invalidVerifier()
  return decoded
}

function invalidVerifier(): Error {
  return new Error("PostgreSQL SCRAM-SHA-256 verifier is invalid.")
}
