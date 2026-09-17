import path from "node:path"
import { lstat } from "node:fs/promises"

import {
  DEFAULT_ARCHIVE_LIMITS,
  validateFetchedArchive,
  type ArchiveLimits,
} from "../../core/runner/archivePolicy"
import { DEFAULT_RUNNER_TIMEOUTS } from "../../core/runner/runnerLimits"
import { validateBackendRuntimePlan } from "../../core/preview/backendRuntimePlanValidator"
import type { BackendRuntimeErrorCode } from "../../types/backendRuntime"
import type { QueuedBackendRuntime } from "../../types/backendRuntime"
import type { PreviewRepositoryRef } from "../../types/preview"
import type { BackendRuntimeControlPlane } from "../backend-runtime-api/controlPlane"
import { minimalNpmEnv } from "../preview-worker/local/npmDependencyInstaller"
import type { ArchiveByteStore } from "../preview-worker/local/archiveByteStore"
import { asLocalWorkspace } from "../preview-worker/local/localWorkspace"
import type { LocalPreviewWorkspace } from "../preview-worker/local/localWorkspace"
import type { ExtractionState } from "../preview-worker/local/extractionState"
import { resolveWorkspaceSourceRoot } from "../preview-worker/local/workspacePath"
import { RunnerDiskLimitError } from "../preview-worker/local/commandRunner"
import type { CommandRunner } from "../preview-worker/local/commandRunner"
import type {
  SandboxProvisioner,
  SourceArchiveFetcher,
} from "../preview-worker/ports"
import { BackendRuntimeReadinessTimeoutError } from "../preview-worker/gvisor/backendRuntimeProcess"
import type {
  BackendRuntimeProcessStarter,
  RuntimeProcessHandle,
} from "./ports"

export interface BackendRuntimeSupervisorOptions {
  archiveLimits?: ArchiveLimits
  installTimeoutMs?: number
  readinessTimeoutMs?: number
  cancellationPollMs?: number
  monitorPollMs?: number
  cleanup?: (runtimeId: string) => void | Promise<void>
}

export interface BackendRuntimeRunOptions {
  signal?: AbortSignal
  recovered?: boolean
  abandon?: boolean
}

/**
 * The backend-v1 counterpart to `PreviewJobWorker`, but deliberately not a
 * reuse of it: `PreviewJobWorker.runPipeline`'s FETCH/INSTALL/BUILD/PUBLISH
 * sequence is fixed and must never grow a persistent-execution phase (see
 * docs/PREVIEW_RUNTIME.md). This orchestrates a wholly separate sequence --
 * FETCH -> INSTALL -> START -> monitor while running -> STOP -> cleanup --
 * that ends in a supervised, still-running process instead of a published
 * artifact.
 *
 * Every dependency below is either already contract-agnostic
 * (`SourceArchiveFetcher`, `SandboxProvisioner`, `ExtractionState`,
 * `CommandRunner`) and reused unchanged from the static pipeline, or new and
 * specific to backend-v1 (`BackendRuntimeProcessStarter`). Nothing here ever
 * touches `BuildPlan`, the static artifact cache, or artifact publication.
 */
export class BackendRuntimeSupervisor {
  private readonly archiveLimits: ArchiveLimits

  constructor(
    private readonly controlPlane: BackendRuntimeControlPlane,
    private readonly archiveFetcher: SourceArchiveFetcher,
    private readonly byteStore: ArchiveByteStore,
    private readonly extraction: ExtractionState,
    private readonly sandbox: SandboxProvisioner,
    private readonly installRunner: CommandRunner,
    private readonly runtimeProcessStarter: BackendRuntimeProcessStarter,
    private readonly options: BackendRuntimeSupervisorOptions = {},
  ) {
    this.archiveLimits = options.archiveLimits ?? DEFAULT_ARCHIVE_LIMITS
  }

  async run(
    queued: QueuedBackendRuntime,
    options: BackendRuntimeRunOptions = {},
  ): Promise<void> {
    options.signal?.throwIfAborted()
    if (
      !(await this.controlPlane.startWorkerRuntime(
        queued.runtimeId,
        options.recovered,
        options.abandon,
      ))
    ) {
      return
    }

    let workspace:
      Awaited<ReturnType<SandboxProvisioner["allocate"]>> | undefined
    let processHandle: RuntimeProcessHandle | undefined
    const controller = new AbortController()
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal

    let stopped = false
    let poll: ReturnType<typeof setTimeout> | undefined
    let checking: Promise<void> | undefined
    const check = async () => {
      try {
        if (
          !(await this.controlPlane.isWorkerRuntimeActive(queued.runtimeId))
        ) {
          controller.abort()
        }
      } catch {
        // Losing contact with the control plane must stop untrusted execution.
        controller.abort(
          new Error("Backend runtime control plane unavailable."),
        )
      }
      if (!stopped && !signal.aborted) schedule()
    }
    const schedule = () => {
      poll = setTimeout(() => {
        checking = check()
      }, this.options.cancellationPollMs ?? 500)
      poll.unref()
    }
    schedule()

    try {
      const plan = validateBackendRuntimePlan(queued.plan)
      if (!sameRepository(queued.repository, plan.repository)) {
        throw new Error(
          "Queued repository and backend runtime plan do not match.",
        )
      }
      workspace = await this.sandbox.allocate(queued.runtimeId)
      signal.throwIfAborted()
      processHandle = await this.fetchInstallStart(
        queued.runtimeId,
        plan,
        asLocalWorkspace(workspace),
        signal,
      )
      signal.throwIfAborted()
      await this.monitorWhileRunning(queued.runtimeId, processHandle, signal)
    } catch (error) {
      // If a status is already terminal (e.g. the user cancelled), this is a
      // no-op regardless of which code is passed -- see
      // `BackendRuntimeControlPlane.failWorkerRuntime`'s ACTIVE_STATUSES
      // guard -- so `signal.aborted` only ever matters for the genuine
      // "control plane became unreachable mid-flight" case, mirroring
      // `PreviewJobWorker.run`'s identical `signal.aborted` fallback.
      await this.controlPlane.failWorkerRuntime(
        queued.runtimeId,
        signal.aborted ? "RUNTIME_UNAVAILABLE" : phaseErrorCode(error),
      )
    } finally {
      stopped = true
      clearTimeout(poll)
      await checking
      try {
        await processHandle?.stop()
      } finally {
        try {
          await workspace?.destroy()
        } finally {
          await this.controlPlane.markStopped(queued.runtimeId)
          await this.options.cleanup?.(queued.runtimeId)
        }
      }
    }
  }

  private async fetchInstallStart(
    runtimeId: string,
    plan: ReturnType<typeof validateBackendRuntimePlan>,
    workspace: LocalPreviewWorkspace,
    signal: AbortSignal,
  ): Promise<RuntimeProcessHandle> {
    signal.throwIfAborted()
    // startWorkerRuntime already moved queued -> fetching.
    const archive = await runPhase("FETCH_FAILED", () =>
      this.archiveFetcher.fetch(plan.repository, signal),
    )
    runPhaseSync("FETCH_FAILED", () =>
      validateFetchedArchive(archive, this.archiveLimits),
    )

    signal.throwIfAborted()
    await this.controlPlane.markPhase(runtimeId, "installing")
    await runPhase("INSTALL_FAILED", () =>
      this.install(plan, workspace, signal),
    )

    signal.throwIfAborted()
    await this.controlPlane.markPhase(runtimeId, "starting")
    const handle = await runPhase("RUNTIME_START_FAILED", () =>
      this.runtimeProcessStarter.start(workspace, plan),
    )

    try {
      await handle.waitUntilReady(this.options.readinessTimeoutMs ?? 30_000)
    } catch (error) {
      await handle.stop().catch(() => undefined)
      throw new RuntimePhaseError(
        error instanceof BackendRuntimeReadinessTimeoutError
          ? "RUNTIME_READINESS_TIMEOUT"
          : "RUNTIME_START_FAILED",
        error,
      )
    }

    signal.throwIfAborted()
    await this.controlPlane.markPhase(runtimeId, "running")
    return handle
  }

  private async install(
    plan: ReturnType<typeof validateBackendRuntimePlan>,
    workspace: LocalPreviewWorkspace,
    signal: AbortSignal,
  ): Promise<void> {
    await this.extraction.ensureExtracted(
      workspace,
      plan.repository.commitSha,
      this.byteStore,
      signal,
    )
    this.byteStore.delete(plan.repository.commitSha)

    const sourceRootDir = await resolveWorkspaceSourceRoot(
      workspace.rootDir,
      plan.sourceRoot,
    )
    if (!(await isRegularFile(path.join(sourceRootDir, "package-lock.json")))) {
      throw new Error(
        "package-lock.json is required inside the backend source root for npm ci.",
      )
    }

    await this.installRunner.run(
      workspace,
      plan.install.command,
      [...plan.install.args],
      {
        signal,
        workingDirectory: plan.sourceRoot,
        timeoutMs:
          this.options.installTimeoutMs ??
          DEFAULT_RUNNER_TIMEOUTS.buildTimeoutMs,
        env: minimalNpmEnv(),
      },
    )
  }

  /** Polls the control plane's own status (which already accounts for TTL
   * expiry and explicit cancel/stop) rather than tracking a separate timer
   * here, and races that against the process's own `waitForExit()` so a
   * crash is detected without waiting for the next poll tick. */
  private async monitorWhileRunning(
    runtimeId: string,
    handle: RuntimeProcessHandle,
    signal: AbortSignal,
  ): Promise<void> {
    // Deliberately not awaited here: `waitForExit()` only resolves once the
    // process has actually exited, and a normal stop (cancel/expiry) is
    // this function *returning*, which is what lets the caller's `stop()`
    // make that happen -- awaiting it in this function's own scope would be
    // a circular wait (it would never resolve until after this function
    // itself returned).
    let exited: { exitCode: number | null } | null = null
    handle
      .waitForExit()
      .then((result) => {
        exited = result
      })
      .catch(() => undefined)

    const pollMs = this.options.monitorPollMs ?? 2_000
    for (;;) {
      if (signal.aborted) return
      if (exited) {
        throw new RuntimePhaseError(
          "RUNTIME_EXITED",
          new Error("Backend runtime process exited unexpectedly."),
        )
      }
      if (!(await this.controlPlane.shouldContinueRunning(runtimeId))) return
      await sleep(pollMs)
    }
  }
}

function sameRepository(
  left: PreviewRepositoryRef,
  right: PreviewRepositoryRef,
): boolean {
  return (
    left.repositoryId === right.repositoryId &&
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase() &&
    left.commitSha.toLowerCase() === right.commitSha.toLowerCase()
  )
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    const stats = await lstat(filePath)
    return stats.isFile() && !stats.isSymbolicLink()
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class RuntimePhaseError extends Error {
  constructor(
    readonly code: BackendRuntimeErrorCode,
    cause: unknown,
  ) {
    super(
      cause instanceof Error
        ? cause.message
        : "Backend runtime supervisor phase failed.",
    )
    this.name = "RuntimePhaseError"
  }
}

async function runPhase<T>(
  code: BackendRuntimeErrorCode,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action()
  } catch (error) {
    throw new RuntimePhaseError(
      error instanceof RunnerDiskLimitError ? "RUNTIME_DISK_LIMIT" : code,
      error,
    )
  }
}

function runPhaseSync<T>(code: BackendRuntimeErrorCode, action: () => T): T {
  try {
    return action()
  } catch (error) {
    throw new RuntimePhaseError(code, error)
  }
}

function phaseErrorCode(error: unknown): BackendRuntimeErrorCode {
  return error instanceof RuntimePhaseError ? error.code : "RUNTIME_UNAVAILABLE"
}
