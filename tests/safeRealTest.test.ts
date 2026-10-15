import { inspect } from "node:util"
import { spawnSync } from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  realTestFailure,
  safeRealTest,
  SafeRealTestError,
} from "./support/safeRealTest"

const marker = "SYNTHETIC-DO-NOT-REPORT"
function hostile() {
  return Object.assign(new Error(marker, { cause: new Error(marker) }), {
    actual: marker,
    expected: marker,
    stdout: marker,
    stderr: marker,
    DATABASE_URL: marker,
    password: marker,
    hash: marker,
    toJSON() {
      throw new Error(marker)
    },
  })
}

describe("real-test failure reporting boundary (synthetic inputs only)", () => {
  it("preserves success and successful cleanup", async () => {
    const calls: string[] = []
    await safeRealTest(async (cleanup) => {
      calls.push("scenario")
      expect(
        await cleanup(async () => {
          calls.push("cleanup")
        }),
      ).toBe(true)
    })()
    expect(calls).toEqual(["scenario", "cleanup"])
  })
  it.each([false, true])(
    "detects digest mismatch through a boolean assertion: match=%s",
    async (match) => {
      const run = safeRealTest(async () => {
        expect(Object.is(marker, match ? marker : "different")).toBe(true)
      })()
      if (match) await expect(run).resolves.toBeUndefined()
      else
        await expect(run).rejects.toMatchObject({
          code: "REAL_SCENARIO_FAILED",
        })
    },
  )
  it.each(["scenario", "cleanup", "both"])(
    "reports %s failure without raw fields or lost cleanup",
    async (which) => {
      const calls: number[] = []
      let caught: unknown
      try {
        await safeRealTest(async (cleanup) => {
          try {
            if (which !== "cleanup") throw hostile()
          } finally {
            await cleanup(async () => {
              calls.push(1)
              if (which !== "scenario") throw hostile()
            })
            await cleanup(async () => {
              calls.push(2)
            })
          }
        })()
      } catch (error) {
        caught = error
      }
      expect(calls).toEqual([1, 2])
      expect(caught).toBeInstanceOf(SafeRealTestError)
      const error = caught as SafeRealTestError
      expect(error.code).toBe(
        which === "both"
          ? "REAL_SCENARIO_AND_CLEANUP_FAILED"
          : which === "cleanup"
            ? "REAL_CLEANUP_FAILED"
            : "REAL_SCENARIO_FAILED",
      )
      for (const serialized of [
        JSON.stringify(error),
        inspect(error, { showHidden: true }),
        String(error),
      ]) {
        expect(serialized.includes(marker)).toBe(false)
      }
      expect(error.stack).toBeUndefined()
      expect(error.cause).toBeUndefined()
      expect(Object.keys(error).sort()).toEqual(["code", "name"])
    },
  )
  it("reconstructs safe failures instead of retaining added fields", async () => {
    const error = Object.assign(realTestFailure(true, true), { actual: marker })
    const run = safeRealTest(async () => {
      throw error
    })()
    await expect(run).rejects.toMatchObject({
      code: "REAL_SCENARIO_AND_CLEANUP_FAILED",
    })
    await run.catch((value) =>
      expect(JSON.stringify(value).includes(marker)).toBe(false),
    )
    expect(new SafeRealTestError(marker as never).code).toBe(
      "REAL_SCENARIO_FAILED",
    )
  })

  it("keeps synthetic secrets out of an actual Vitest failure report", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "safe-real-report-"))
    try {
      const vitest = new URL(
        "../node_modules/vitest/dist/index.js",
        import.meta.url,
      ).href
      const helper = new URL("./support/safeRealTest.ts", import.meta.url).href
      await writeFile(
        path.join(root, "report.test.ts"),
        `
import { it, expect } from ${JSON.stringify(vitest)};
import { safeRealTest } from ${JSON.stringify(helper)};
it('synthetic assertion', safeRealTest(async () => {
  expect(${JSON.stringify(marker)}).toBe('different');
}));
it('synthetic cleanup', safeRealTest(async cleanup => {
  await cleanup(async () => { throw Object.assign(new Error(${JSON.stringify(marker)}), {hash:${JSON.stringify(marker)}}); });
}));
it('synthetic both', safeRealTest(async cleanup => {
  try { throw new Error(${JSON.stringify(marker)}); }
  finally { await cleanup(async () => { throw new Error(${JSON.stringify(marker)}); }); }
}));
`,
      )
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
          ),
          "run",
          "--root",
          root,
          "--reporter=json",
          "--maxWorkers=1",
        ],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            TEMP: os.tmpdir(),
            TMP: os.tmpdir(),
          },
        },
      )
      expect(result.status).toBe(1)
      const output = result.stdout + result.stderr
      expect(output.includes(marker)).toBe(false)
      for (const code of [
        "REAL_SCENARIO_FAILED",
        "REAL_CLEANUP_FAILED",
        "REAL_SCENARIO_AND_CLEANUP_FAILED",
      ])
        expect(output.includes(code)).toBe(true)
      const report = JSON.parse(result.stdout) as { numFailedTests: number }
      expect(report.numFailedTests).toBe(3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 40_000)
})
