/** R5-2 entry point ONLY: run inside the separately approved, credential-free
 * test unit. This file never creates/configures/starts/stops a systemd unit. */
import { execFile, spawn } from "node:child_process"
import { lstat, readFile, realpath } from "node:fs/promises"
import path from "node:path/posix"
import { fileURLToPath } from "node:url"

import {
  journalIdentity,
  JOURNAL_MAX_BYTES,
  M12_JOURNAL_TEST_FILTER,
  verifyIsolatedJournalRun,
  type JournalScope,
  type JournalSource,
} from "./isolatedJournalVerification"
import { m12RealSuiteEnabled } from "./m12RealGvisorHarness"

// An exact, namespace-specific config is deliberately required rather than
// assuming the host's effective defaults. Provisioning needs separate approval.
export const M12_JOURNAL_CONFIG = [
  "[Journal]",
  "Storage=volatile",
  "MaxLevelStore=debug",
  "ReadKMsg=no",
  "Audit=keep",
  "RateLimitIntervalSec=0",
  "RateLimitBurst=0",
  "ForwardToSyslog=no",
  "ForwardToKMsg=no",
  "ForwardToConsole=no",
  "ForwardToWall=no",
  "",
].join("\n")

function command(binary: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      {
        encoding: "buffer",
        maxBuffer: JOURNAL_MAX_BYTES,
        timeout: 10_000,
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
      },
      (error, stdout, stderr) => {
        // Never propagate child output, command errors or buffers into evidence.
        if (error || stderr.length)
          reject(new Error("ISOLATED_JOURNAL_COMMAND_INCOMPLETE"))
        else resolve(stdout)
      },
    )
  })
}

/** Each ancestor must remain canonical/non-symlink and root-owned, with no
 * group/world write access. Returns identity, not contents or a raw error. */
export async function inspectOwnedJournalPath(
  candidate: string,
  directory: boolean,
) {
  if (
    !path.isAbsolute(candidate) ||
    path.normalize(candidate) !== candidate ||
    (await realpath(candidate)) !== candidate
  )
    throw new Error("ISOLATED_JOURNAL_PATH_INVALID")
  const parts = candidate.split("/").filter(Boolean)
  let current = "/"
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part)
    const info = await lstat(current)
    if (
      info.isSymbolicLink() ||
      info.uid !== 0 ||
      (info.mode & 0o022) !== 0 ||
      (index < parts.length - 1
        ? !info.isDirectory()
        : directory
          ? !info.isDirectory()
          : !info.isFile())
    )
      throw new Error("ISOLATED_JOURNAL_OWNERSHIP_INVALID")
  }
  return lstat(candidate)
}

export async function inspectLinuxJournalSource(
  scope: JournalScope,
): Promise<JournalSource> {
  const identity = journalIdentity(scope)
  const info = await inspectOwnedJournalPath(identity.directory, true)
  const configPath = `/etc/systemd/journald@${identity.namespace}.conf`
  const configInfo = await inspectOwnedJournalPath(configPath, false)
  if (configInfo.size > 4096) throw new Error("ISOLATED_JOURNAL_CONFIG_BOUND")
  if ((await readFile(configPath, "utf8")) !== M12_JOURNAL_CONFIG)
    throw new Error("ISOLATED_JOURNAL_CONFIG_INVALID")
  const effective = await command("/usr/bin/systemd-analyze", [
    "cat-config",
    `systemd/journald@${identity.namespace}.conf`,
  ])
  const settings =
    effective
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("#"))
      .join("\n") + "\n"
  // Refuse unknown/overriding drop-ins rather than assuming the one file wins.
  if (settings !== M12_JOURNAL_CONFIG)
    throw new Error("ISOLATED_JOURNAL_EFFECTIVE_CONFIG_INVALID")
  // These metadata properties cannot contain Environment= or credentials.
  const properties = [
    "LogNamespace",
    "InvocationID",
    "MainPID",
    "ActiveState",
    "StandardOutput",
    "StandardError",
    "LogRateLimitIntervalUSec",
    "LogRateLimitBurst",
  ]
  const output = await command("/usr/bin/systemctl", [
    "show",
    identity.unit,
    `--property=${properties.join(",")}`,
    "--no-pager",
  ])
  const values = Object.fromEntries(
    output
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const i = line.indexOf("=")
        return [line.slice(0, i), line.slice(i + 1)]
      }),
  )
  return {
    directory: identity.directory,
    namespace: values.LogNamespace ?? "",
    unit: identity.unit,
    invocationId: values.InvocationID ?? "",
    mainPid: Number(values.MainPID),
    active: values.ActiveState === "active",
    stdout: values.StandardOutput ?? "",
    stderr: values.StandardError ?? "",
    rateLimitInterval: values.LogRateLimitIntervalUSec ?? "",
    rateLimitBurst: values.LogRateLimitBurst ?? "",
    owned: true,
    device: info.dev,
    inode: info.ino,
  }
}

export async function collectLinuxJournal(namespace: string): Promise<Buffer> {
  if (!/^peephole-m12-[a-f0-9]{32}$/.test(namespace))
    throw new Error("ISOLATED_JOURNAL_NAMESPACE_INVALID")
  await command("/usr/bin/journalctl", [`--namespace=${namespace}`, "--sync"])
  // No host/default namespace fallback, time/unit filters, tail limit,
  // grep, or output-fields projection. --all prevents null truncation.
  return command("/usr/bin/journalctl", [
    `--namespace=${namespace}`,
    "--no-pager",
    "--output=json",
    "--all",
  ])
}

function runExistingLifecycleTests(repository: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "node_modules/vitest/vitest.mjs",
        "run",
        "tests/realUserEnvironmentRuntime.test.ts",
        "-t",
        M12_JOURNAL_TEST_FILTER,
        "--reporter=dot",
      ],
      { cwd: repository, stdio: "inherit" },
    )
    child.once("error", () => resolve(1))
    // Wait for the full test child, including its reporters and awaited cleanup.
    child.once("close", (code) => resolve(code ?? 1))
  })
}

async function main(): Promise<void> {
  let exitCode = 1
  try {
    if (
      process.platform !== "linux" ||
      process.getuid?.() !== 0 ||
      !m12RealSuiteEnabled(process.env)
    )
      throw new Error("ISOLATED_JOURNAL_NOT_APPROVED")
    const scope: JournalScope = {
      runId: process.env.PEEPHOLE_M12_TEST_JOURNAL_RUN_ID ?? "",
      invocationId: process.env.INVOCATION_ID ?? "",
      pid: process.pid,
      machineId: (await readFile("/etc/machine-id", "utf8")).trim(),
      bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8"))
        .trim()
        .replaceAll("-", ""),
    }
    const repository = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../..",
    )
    const result = await verifyIsolatedJournalRun(
      scope,
      () => runExistingLifecycleTests(repository),
      {
        inspect: () => inspectLinuxJournalSource(scope),
        writeMarker: (message) =>
          new Promise<void>((resolve, reject) => {
            process.stdout.write(`${message}\n`, (error) =>
              error
                ? reject(new Error("ISOLATED_JOURNAL_WRITE_FAILED"))
                : resolve(),
            )
          }),
        collect: collectLinuxJournal,
      },
    )
    process.stdout.write(`[m12-journal-evidence] ${JSON.stringify(result)}\n`)
    exitCode = result.status === "PASS" && result.scenarioPassed ? 0 : 1
  } catch {
    process.stdout.write(
      '[m12-journal-evidence] {"status":"INCOMPLETE","complete":false}\n',
    )
  }
  process.exitCode = exitCode
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main()
