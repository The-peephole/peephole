import { randomBytes } from "node:crypto"

import type { OpaqueSecretValue } from "../../types/backendRuntimeSecrets"

/** 256 bits, matching docs/EPHEMERAL_SECRETS.md section 13's minimum
 * entropy. Fixed -- this PR deliberately does not expose a configurable
 * length or encoding. */
const SECRET_BYTE_LENGTH = 32

/**
 * Wraps `raw` so the only way to read it back out is the explicit
 * `reveal()` call. The raw string is captured only in this closure -- never
 * assigned to any property of the returned object -- so there is no
 * enumerable field for `JSON.stringify`, `Object.keys`, `for...in`, or
 * default object inspection to find. `String(value)`/template-literal
 * coercion falls through to `Object.prototype.toString`
 * (`"[object Object]"`) since no `toString`/`valueOf`/`Symbol.toPrimitive`
 * is defined.
 *
 * This is NOT cryptographic memory zeroization -- Node/V8 give no guarantee
 * the underlying string is scrubbed from the heap once unreferenced. This
 * only minimizes *references*: exactly one closure holds the value, and
 * nothing else in this codebase may add another.
 */
export function createOpaqueSecretValue(raw: string): OpaqueSecretValue {
  return Object.freeze({
    reveal: () => raw,
  })
}

/**
 * Generates one fresh, independent secret value: 32 CSPRNG bytes
 * (`node:crypto`'s `randomBytes`, the same primitive already used
 * elsewhere in this codebase for ids -- see `services/preview-worker/gvisor/backendRuntimeProcess.ts`),
 * base64url-encoded, unpadded. Base64url's alphabet
 * (`A-Za-z0-9-_`) contains no NUL or control characters and no shell
 * metacharacters by construction, and Node's `"base64url"` encoding never
 * emits `=` padding.
 *
 * Called once per secret name per issuance -- every call returns
 * independent material, never reused.
 */
export function generatePreviewSecretValue(): OpaqueSecretValue {
  const raw = randomBytes(SECRET_BYTE_LENGTH).toString("base64url")
  return createOpaqueSecretValue(raw)
}
