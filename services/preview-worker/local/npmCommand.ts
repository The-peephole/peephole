export function resolveNpmExecutable(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm"
}
