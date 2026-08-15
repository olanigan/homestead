import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join, resolve } from "node:path"
import { runCli, startCli, type RunningCli, freePort, sleep } from "./helpers.js"

// Regression coverage for epic-002-foundation.yaml:story-212 — LlamaCppAdapter used to keep
// per-serve state (process/port/pid-file) as singleton instance fields shared across ALL
// models. Serving a second GGUF model while a first was still running corrupted or, via the
// old single global PID file, actively killed the first model's process. stop() on one model
// could also kill a different, more-recently-served model's process instead of the one asked
// for. These tests exercise the real CLI (import/serve/stop/status) against a fake
// `llama-server` binary (tests/e2e/fixtures/llama-server — a plain bash script so `ps -o
// comm=` reports "llama-server", matching what the adapter's stale-PID-file detection checks
// for) so they run without needing a real GGUF model or a real llama.cpp build — unlike
// serve.test.ts, this suite is never skipped.

const FIXTURES_DIR = resolve(import.meta.dir, "fixtures")
const PID_DIR = join(homedir(), ".homestead")

function pidFileFor(modelId: string): string {
  const safe = modelId.replace(/[^a-zA-Z0-9._-]/g, "_")
  return join(PID_DIR, `llama-server-${safe}.pid`)
}

let tmpDir = ""
let cliEnv: Record<string, string> = {}
let modelAId = ""
let modelBId = ""
let portA = 0
let portB = 0
let serveA: RunningCli | null = null
let serveB: RunningCli | null = null

async function waitFor(port: number, expect200: boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_500) })
      if ((res.status === 200) === expect200) return true
    } catch {
      if (!expect200) return true // connection refused counts as "down"
    }
    await sleep(300)
  }
  return false
}

async function importModel(name: string): Promise<string> {
  const path = join(tmpDir, `${name}.gguf`)
  writeFileSync(path, `fake-${name}-weights`)
  const res = await runCli(["import", path], { env: cliEnv })
  expect(res.code).toBe(0)
  const listed = await runCli(["list", "--json"], { env: cliEnv })
  const models = JSON.parse(listed.stdout) as Array<{ id: string; name: string; sourceId: string }>
  const found = models.find((m) => m.sourceId === path)
  expect(found).toBeDefined()
  return found!.id
}

describe("LlamaCppAdapter concurrent serving (story-212 regression)", () => {
  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "homestead-concurrency-e2e-"))
    cliEnv = {
      HOMESTEAD_DB_PATH: join(tmpDir, "models.db"),
      HOMESTEAD_OBS_DB_PATH: join(tmpDir, "obs.db"),
      PATH: `${FIXTURES_DIR}:${process.env.PATH ?? ""}`,
    }
    modelAId = await importModel("model-a")
    modelBId = await importModel("model-b")
  })

  afterAll(async () => {
    for (const id of [modelAId, modelBId]) {
      try {
        await runCli(["stop", id], { env: cliEnv, timeoutMs: 10_000 })
      } catch {}
    }
    if (serveA) serveA.proc.kill("SIGKILL")
    if (serveB) serveB.proc.kill("SIGKILL")
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  test("two different models can be served concurrently without either corrupting or killing the other", async () => {
    portA = await freePort()
    portB = await freePort()

    serveA = startCli(["serve", modelAId, "-p", String(portA)], { env: cliEnv })
    expect(await waitFor(portA, true)).toBe(true)

    // This is the core regression: starting a SECOND model used to run
    // cleanupStalePidFile() against a single shared PID file and kill model A's still-alive,
    // legitimately-serving process before model B ever started.
    serveB = startCli(["serve", modelBId, "-p", String(portB)], { env: cliEnv })
    expect(await waitFor(portB, true)).toBe(true)

    // Re-check A explicitly, after B has started — this is what the old bug broke.
    const stillHealthyA = await fetch(`http://127.0.0.1:${portA}/health`)
    expect(stillHealthyA.status).toBe(200)

    expect(existsSync(pidFileFor(modelAId))).toBe(true)
    expect(existsSync(pidFileFor(modelBId))).toBe(true)
  })

  test("status --json reports both concurrently-served models with correct, uncorrupted ports/pids", async () => {
    const res = await runCli(["status", "--json"], { env: cliEnv })
    expect(res.code).toBe(0)
    const data = JSON.parse(res.stdout) as {
      processes: Array<{ modelId: string; port: number; pid: number }>
    }
    const procA = data.processes.find((p) => p.modelId === modelAId)
    const procB = data.processes.find((p) => p.modelId === modelBId)
    expect(procA?.port).toBe(portA)
    expect(procB?.port).toBe(portB)
    // The old singleton-instance-field bug meant the LATER serve() call's port/pid could
    // leak into the EARLIER model's tracked state. Confirm they're distinct.
    expect(procA?.pid).not.toBe(procB?.pid)
    expect(procA?.port).not.toBe(procB?.port)
  })

  test("stopping model A does not kill model B's process (the stop()-kills-wrong-process bug)", async () => {
    const stopRes = await runCli(["stop", modelAId], { env: cliEnv })
    expect(stopRes.code).toBe(0)

    expect(await waitFor(portA, false)).toBe(true)
    // The regression: stop(sp) used to read a single `this.process` field that always
    // pointed at whichever model was served MOST RECENTLY (model B), so stopping the
    // EARLIER model (A) could SIGTERM/SIGKILL model B's process instead.
    const stillHealthyB = await fetch(`http://127.0.0.1:${portB}/health`)
    expect(stillHealthyB.status).toBe(200)

    // Only model A's PID file should be gone — clearPidFile() used to wipe a single shared
    // file regardless of which model was actually stopped.
    expect(existsSync(pidFileFor(modelAId))).toBe(false)
    expect(existsSync(pidFileFor(modelBId))).toBe(true)

    if (serveA) {
      try { await serveA.waitForExit(10_000) } catch { serveA.proc.kill("SIGKILL") }
      serveA = null
    }
  })

  test("stopping model B cleans up cleanly with no leftover PID files", async () => {
    const stopRes = await runCli(["stop", modelBId], { env: cliEnv })
    expect(stopRes.code).toBe(0)
    expect(await waitFor(portB, false)).toBe(true)
    expect(existsSync(pidFileFor(modelBId))).toBe(false)

    if (serveB) {
      try { await serveB.waitForExit(10_000) } catch { serveB.proc.kill("SIGKILL") }
      serveB = null
    }
  })
})

describe("LlamaCppAdapter stale-PID recovery stays scoped to one model", () => {
  let tmp2 = ""
  let env2: Record<string, string> = {}
  let modelCId = ""
  let modelDId = ""
  let portC = 0
  let portD = 0
  let serveC: RunningCli | null = null
  let serveD: RunningCli | null = null

  beforeAll(async () => {
    tmp2 = mkdtempSync(join(tmpdir(), "homestead-stale-pid-e2e-"))
    env2 = {
      HOMESTEAD_DB_PATH: join(tmp2, "models.db"),
      HOMESTEAD_OBS_DB_PATH: join(tmp2, "obs.db"),
      PATH: `${FIXTURES_DIR}:${process.env.PATH ?? ""}`,
    }
    const pathC = join(tmp2, "model-c.gguf")
    const pathD = join(tmp2, "model-d.gguf")
    writeFileSync(pathC, "fake-model-c-weights")
    writeFileSync(pathD, "fake-model-d-weights")
    await runCli(["import", pathC], { env: env2 })
    await runCli(["import", pathD], { env: env2 })
    const listed = await runCli(["list", "--json"], { env: env2 })
    const models = JSON.parse(listed.stdout) as Array<{ id: string; sourceId: string }>
    modelCId = models.find((m) => m.sourceId === pathC)!.id
    modelDId = models.find((m) => m.sourceId === pathD)!.id
  })

  afterAll(async () => {
    for (const id of [modelCId, modelDId]) {
      try { await runCli(["stop", id], { env: env2, timeoutMs: 10_000 }) } catch {}
    }
    if (serveC) serveC.proc.kill("SIGKILL")
    if (serveD) serveD.proc.kill("SIGKILL")
    if (tmp2) rmSync(tmp2, { recursive: true, force: true })
  })

  test("a hard-killed model's stale PID file is cleaned up on its own re-serve without touching an unrelated live model", async () => {
    portC = await freePort()
    portD = await freePort()

    serveC = startCli(["serve", modelCId, "-p", String(portC)], { env: env2 })
    const upC = await new Promise<boolean>((r) => {
      const deadline = Date.now() + 15_000
      const check = async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${portC}/health`, { signal: AbortSignal.timeout(1_000) })
          if (res.status === 200) return r(true)
        } catch {}
        if (Date.now() > deadline) return r(false)
        setTimeout(check, 300)
      }
      check()
    })
    expect(upC).toBe(true)
    expect(existsSync(pidFileFor(modelCId))).toBe(true)

    // Simulate a hard crash: kill -9 the CLI's serve process directly (not via `homestead
    // stop`), leaving the PID file behind with a now-dead PID — the exact state
    // cleanupStalePidFile() is meant to recover from.
    serveC.proc.kill("SIGKILL")
    await serveC.waitForExit(10_000).catch(() => {})
    serveC = null
    await sleep(500)
    expect(existsSync(pidFileFor(modelCId))).toBe(true) // file survives the crash

    // Start an unrelated model D concurrently. Under the old single-shared-PID-file bug,
    // D's serve() would run cleanupStalePidFile() against the SAME file C used, see a
    // (now-dead, but formerly a different model's) recorded PID, and potentially disrupt
    // state that had nothing to do with D. With per-model PID files, D's serve() never even
    // looks at C's file.
    serveD = startCli(["serve", modelDId, "-p", String(portD)], { env: env2 })
    const upD = await waitFor(portD, true)
    expect(upD).toBe(true)

    // Now re-serve C. Its own stale PID file (dead PID, from the kill -9 above) should be
    // detected and cleared by cleanupStalePidFile(modelCId), and C should come back up
    // cleanly — without disturbing D, which never stops responding.
    serveC = startCli(["serve", modelCId, "-p", String(portC)], { env: env2 })
    expect(await waitFor(portC, true)).toBe(true)

    const stillUpD = await fetch(`http://127.0.0.1:${portD}/health`)
    expect(stillUpD.status).toBe(200)
  })
})
