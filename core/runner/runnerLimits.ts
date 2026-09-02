export interface SandboxResourceLimits {
  cpuCount: number
  memoryBytes: number
  maxPids: number
}

export interface RunnerTimeouts {
  totalJobTimeoutMs: number
  buildTimeoutMs: number
}

export const DEFAULT_SANDBOX_RESOURCE_LIMITS: SandboxResourceLimits = {
  cpuCount: 1,
  memoryBytes: 1 * 1024 * 1024 * 1024,
  maxPids: 128,
}

export const DEFAULT_RUNNER_TIMEOUTS: RunnerTimeouts = {
  totalJobTimeoutMs: 180_000,
  buildTimeoutMs: 120_000,
}

export const RUNNER_PLATFORM = {
  os: "linux",
  arch: "x86_64",
  nodeVersion: "24",
  packageManager: "npm",
} as const

export const MAX_CAPTURED_LOG_BYTES = 64 * 1024
