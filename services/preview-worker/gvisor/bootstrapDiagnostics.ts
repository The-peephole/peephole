import type { BackendFailureStep } from "../../backend-runtime-api/diagnostics"

// Mirrored by the standalone, immutable rootfs bootstrap. Never parse app values.
export const BOOTSTRAP_READY = "[peephole-bootstrap-v1] ready"
export const BOOTSTRAP_FAILED = "[peephole-bootstrap-v1] failed"
export const APPLICATION_STARTED = "[peephole-bootstrap-v1] application-started"

/** First bootstrap outcome wins. App output after ready cannot turn it into
 * a bootstrap failure. Old images/truncation yield UNVERIFIED, not a guess.
 * This relies on the attested bootstrap writing ready synchronously BEFORE
 * spawning repository code; it is not a cryptographic runtime attestation. */
export function classifyBootstrapExit(stderr: string): BackendFailureStep {
  let ready = false
  for (const line of stderr.split(/\r?\n/)) {
    if (!ready) {
      if (line === BOOTSTRAP_FAILED) return "BOOTSTRAP_REPORTED_FAILURE"
      if (line === BOOTSTRAP_READY) ready = true
    } else if (line === APPLICATION_STARTED) {
      return "APPLICATION_REPORTED_EXIT"
    }
  }
  return ready ? "APPLICATION_START_UNVERIFIED" : "RUNSC_EXIT_UNVERIFIED"
}
