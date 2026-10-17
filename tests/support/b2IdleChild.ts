// Harmless stand-in child for the Portable B2 identity test (never the
// server): stays alive until SIGTERM, then exits 0. It opens no port and
// touches no file.
const keepAlive = setInterval(() => undefined, 1_000)
process.on("SIGTERM", () => {
  clearInterval(keepAlive)
  process.exit(0)
})
