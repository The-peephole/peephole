/**
 * backend-v1 has one installer contract: npm with a committed package-lock.
 * Keep this declaration check shared by local compatibility reporting and
 * exact-commit server authorization so they cannot advertise different
 * package-manager support.
 */
export function isNpmBackendPackageManagerDeclaration(
  value: string | null | undefined,
): boolean {
  return (
    value === null ||
    value === undefined ||
    /^npm(?:@[A-Za-z0-9.+_-]+)?$/.test(value)
  )
}
