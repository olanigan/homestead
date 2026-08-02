import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, linkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  resolveModelPath,
  runCli,
  startCli,
  type RunningCli,
  freePort,
  chatCompletion,
  sleep,
} from "./helpers.js"

const MODEL_PATH = resolveModelPath()
const noModel = MODEL_PATH === null

const EVAL_TASKS = [
  { id: "capital-france", prompt: "What is the capital of France? Answer in one word.", expected: "paris" },
  { id: "add-two", prompt: "What is 2+2? Answer with just the number.", expected: "4" },
  { id: "multiply", prompt: "What is 6 times 7? Answer with just the number.", expected: "42" },
  { id: "largest-planet", prompt: "Which is the largest planet in our solar system?", expected: "jupiter" },
  { id: "language-japan", prompt: "What language is spoken in Japan?", expected: "japanese" },
  { id: "color-sky", prompt: "What color is the sky on a clear day?", expected: "blue" },
]

let PORT = 0
let tmpDir = ""
let cliEnv: Record<string, string> = {}
let modelId = ""
let serveProc: RunningCli | null = null

async function startServer(): Promise<void> {
  if (!MODEL_PATH) return
  tmpDir = mkdtempSync(join(tmpdir(), "homestead-e2e-"))
  cliEnv = {
    HOMESTEAD_DB_PATH: join(tmpDir, "models.db"),
    HOMESTEAD_OBS_DB_PATH: join(tmpDir, "obs.db"),
  }
  PORT = await freePort()

  const imported = await runCli(["import", MODEL_PATH], { env: cliEnv })
  expect(imported.code).toBe(0)
  expect(imported.stdout).toContain("Imported")

  const listed = await runCli(["list", "--json"], { env: cliEnv })
  expect(listed.code).toBe(0)
  const models = JSON.parse(listed.stdout) as Array<{ id: string; name: string; format: string; engine: string | null }>
  modelId = models[0]?.id ?? ""
  expect(modelId).not.toBe("")
  expect(models[0]?.format).toBe("gguf")
  expect(models[0]?.engine).toBe("llama.cpp")

  serveProc = startCli(["serve", modelId, "-p", String(PORT)], { env: cliEnv })

  const deadline = Date.now() + 90_000
  let healthy = false
  while (Date.now() < deadline) {
    if (serveProc.proc.exitCode !== null) {
      throw new Error(
        `serve CLI exited early (code=${serveProc.proc.exitCode})\n--- stdout ---\n${serveProc.stdout}\n--- stderr ---\n${serveProc.stderr}`,
      )
    }
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2_000) })
      if (res.status === 200) {
        healthy = true
        break
      }
    } catch {
      /* not ready yet */
    }
    await sleep(400)
  }
  expect(healthy).toBe(true)
}

async function stopServer(): Promise<void> {
  if (!modelId) return
  await runCli(["stop", modelId], { env: cliEnv })
  if (serveProc) {
    try {
      await serveProc.waitForExit(15_000)
    } catch {
      serveProc.proc.kill("SIGKILL")
    }
  }
  serveProc = null
}

describe.skipIf(noModel)("homestead serve e2e (LFM2-350M)", () => {
  beforeAll(startServer)
  afterAll(async () => {
    await stopServer()
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  test("health endpoint is ready", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`)
    expect(res.status).toBe(200)
  })

  test("OpenAI-compatible /v1/models lists the served model", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/models`)
    expect(res.status).toBe(200)
    const data = (await res.json()) as { data?: Array<{ id: string }> }
    expect(data.data?.length ?? 0).toBeGreaterThan(0)
  })

  test("chat completion returns non-empty content", async () => {
    const { status, data } = await chatCompletion(PORT, [
      { role: "user", content: "Say hello in one short word." },
    ])
    expect(status).toBe(200)
    const content = data.choices[0]?.message?.content ?? ""
    expect(content.length).toBeGreaterThan(0)
    expect(data.choices[0]?.finish_reason).toBe("stop")
    expect(data.usage?.completion_tokens ?? 0).toBeGreaterThan(0)
  })

  test("streaming chat yields content deltas", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "homestead",
        messages: [{ role: "user", content: "Count from 1 to 3." }],
        max_tokens: 32,
        temperature: 0,
        stream: true,
      }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    const deltas = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter((p) => p && p !== "[DONE]")
    expect(deltas.length).toBeGreaterThan(0)
  })

  test("CPU throughput is above zero tokens/sec", async () => {
    const { status, data, elapsedMs } = await chatCompletion(
      PORT,
      [{ role: "user", content: "Write a sentence about the weather." }],
      { maxTokens: 32 },
    )
    expect(status).toBe(200)
    const tokens = data.usage?.completion_tokens ?? 0
    expect(tokens).toBeGreaterThan(0)
    const tps = tokens / (elapsedMs / 1000)
    expect(tps).toBeGreaterThan(0)
    console.log(`  [throughput] ${tokens} tokens in ${elapsedMs.toFixed(0)}ms ≈ ${tps.toFixed(1)} tok/s`)
  })

  test("status --json shows the serving process cross-process", async () => {
    const res = await runCli(["status", "--json"], { env: cliEnv })
    expect(res.code).toBe(0)
    const data = JSON.parse(res.stdout) as {
      engines: Array<{ kind: string }>
      processes: Array<{ modelId: string; port: number }>
    }
    expect(data.engines.some((e) => e.kind === "llama.cpp")).toBe(true)
    expect(data.processes.some((p) => p.modelId === modelId && p.port === PORT)).toBe(true)
  })

  test("observability records a serving session", async () => {
    const res = await runCli(["obs", "--json"], { env: cliEnv })
    expect(res.code).toBe(0)
    const data = JSON.parse(res.stdout) as {
      stats: { total_sessions: number; by_type: Record<string, number> }
      sessions: Array<{ model_id: string; status: string }>
    }
    expect(data.stats.total_sessions).toBeGreaterThanOrEqual(1)
    expect(data.stats.by_type.model_loaded ?? 0).toBeGreaterThanOrEqual(1)
    expect(data.sessions.some((s) => s.model_id === modelId && s.status === "active")).toBe(true)
  })

  describe("informational eval (not gating on accuracy)", () => {
    test("runs a deterministic task set and writes a JSONL artifact", async () => {
      const results: Array<Record<string, unknown>> = []
      let correct = 0

      for (const task of EVAL_TASKS) {
        const { status, data, elapsedMs } = await chatCompletion(
          PORT,
          [{ role: "user", content: task.prompt }],
          { maxTokens: 32 },
        )
        const content = (data.choices[0]?.message?.content ?? "").trim()
        expect(status).toBe(200)
        expect(content.length).toBeGreaterThan(0)
        const reward = content.toLowerCase().includes(task.expected) ? 1 : 0
        correct += reward
        results.push({
          taskId: task.id,
          prompt: task.prompt,
          reply: content,
          expected: task.expected,
          reward,
          tokens: data.usage?.completion_tokens ?? 0,
          elapsedMs: Math.round(elapsedMs),
        })
      }

      const accuracy = correct / EVAL_TASKS.length
      const outPath = process.env.CI_EVAL_OUT ?? resolve(import.meta.dir, "../../.ci/eval-results.jsonl")
      mkdirSync(resolve(outPath, ".."), { recursive: true })
      writeFileSync(outPath, results.map((r) => JSON.stringify(r)).join("\n") + "\n")

      console.log(
        `\n  [eval] tasks=${EVAL_TASKS.length} correct=${correct}/${EVAL_TASKS.length} accuracy=${(accuracy * 100).toFixed(0)}% artifact=${outPath}\n`,
      )
    })
  })

  test("stop frees the port and records an unload event", async () => {
    await stopServer()
    await sleep(500)
    await expect(
      fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2_000) }),
    ).rejects.toThrow()

    const res = await runCli(["obs", "--json"], { env: cliEnv })
    expect(res.code).toBe(0)
    const data = JSON.parse(res.stdout) as {
      stats: { by_type: Record<string, number> }
      sessions: Array<{ model_id: string; status: string }>
    }
    expect(data.stats.by_type.model_unloaded ?? 0).toBeGreaterThanOrEqual(1)
    expect(data.sessions.some((s) => s.model_id === modelId && s.status === "completed")).toBe(true)
  })
})

describe.skipIf(noModel)("homestead discover (gguf-file scanner)", () => {
  test("finds a GGUF placed in a scanned directory", async () => {
    if (!MODEL_PATH) return
    const homeDir = mkdtempSync(join(tmpdir(), "homestead-home-"))
    const modelsDir = join(homeDir, "models")
    mkdirSync(modelsDir, { recursive: true })
    linkSync(MODEL_PATH, join(modelsDir, "LFM2-350M-Q4_K_M.gguf"))
    const dbPath = join(homeDir, "discover.db")
    try {
      const res = await runCli(["discover", "--json"], {
        env: {
          HOME: homeDir,
          HOMESTEAD_DB_PATH: dbPath,
          HOMESTEAD_OBS_DB_PATH: join(homeDir, "obs.db"),
        },
        timeoutMs: 60_000,
      })
      expect(res.code).toBe(0)
      const data = JSON.parse(res.stdout) as { models: Array<{ source: string; name: string }> }
      const found = data.models.some((m) => m.source === "gguf-file" && m.name === "LFM2-350M-Q4_K_M")
      expect(found).toBe(true)
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
    }
  })
})
