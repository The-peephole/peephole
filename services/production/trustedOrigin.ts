/** Validate before interpolation into CSP, including standalone artifact hosts. */
export function validateTrustedAppOrigin(
  value: string,
  trustedRegistrableDomain?: string,
): string {
  const invalid = () =>
    new Error(
      "PEEPHOLE_TRUSTED_APP_ORIGIN must be an exact HTTPS origin within the trusted domain, without credentials, explicit port, path, query, or fragment.",
    )
  // URL parsing normalizes away :443, dot paths, and some whitespace.
  // Check raw syntax first so those inputs cannot bypass validation.
  if (value !== value.trim()) throw invalid()
  if (!/^https:\/\/[a-z\d.-]+\/?$/i.test(value)) throw invalid()
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalid()
  }
  const hostname = url.hostname
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    hostname.length > 253 ||
    hostname.endsWith(".localhost") ||
    /^[\d.]+$/.test(hostname) ||
    hostname.split(".").some((label) => label.length > 63) ||
    !/^[a-z\d]([a-z\d-]*[a-z\d])?(\.[a-z\d]([a-z\d-]*[a-z\d])?)+$/.test(
      hostname,
    ) ||
    (trustedRegistrableDomain !== undefined &&
      hostname !== trustedRegistrableDomain &&
      !hostname.endsWith(`.${trustedRegistrableDomain}`))
  )
    throw invalid()
  return url.origin
}
