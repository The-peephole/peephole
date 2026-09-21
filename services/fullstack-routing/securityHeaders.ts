export function previewSecurityHeaders(
  trustedAppOrigin: string,
  connectSource: "'none'" | "'self'",
): Record<string, string> {
  return {
    "cache-control": "no-store",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "x-content-type-options": "nosniff",
    "content-security-policy": `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src ${connectSource}; object-src 'none'; base-uri 'self'; form-action 'none'; frame-src 'none'; worker-src 'none'; frame-ancestors ${trustedAppOrigin} chrome-extension:`,
  }
}
