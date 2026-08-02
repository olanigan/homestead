import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

export const CLI_PATH = resolve(import.meta.dir, "../../dist/homestead.js")

export interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface RunningCli {
  proc: ChildProcess
  get stdout(): string
  get stderr(): string
  waitForExit(timeoutMs?: number): Promise<number | null>
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Resolve the test model. Prefers CI_MODEL_PATH, otherwise the local
 * `.ci/models` checkout. Returns null (→ tests skip) when unavailable.
 */
export function resolveModelPath(): string | null {
  const fromEnv = process.env.CI_MODEL_PATH
  if (fromEnv && existsSync(fromEnv)) return resolve(fromEnv)
  const local = resolve(import.meta.dir, "../../.ci/models/LFM2-350M-Q4_K_M.gguf")
  return existsSync(local) ? local : null
}

/** Run the homestead CLI to completion. */
export function runCli(
  args: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", (d) => (stdout += d))
    proc.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => {
      proc.kill("SIGKILL")
      reject(new Error(`homestead CLI timed out after ${opts.timeoutMs ?? 30_000}ms: homestead ${args.join(" ")}`))
    }, opts.timeoutMs ?? 30_000)
    proc.on("error", reject)
    proc.on("close", (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr })
    })
  })
}

/** Start the homestead CLI without waiting (e.g. `homestead serve` stays alive). */
export function startCli(
  args: string[],
  opts: { env?: Record<string, string> } = {},
): RunningCli {
  const proc = spawn(process.execPath, [CLI_PATH, ...args], {
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  proc.stdout.on("data", (d) => (stdout += d))
  proc.stderr.on("data", (d) => (stderr += d))
  return {
    proc,
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
    waitForExit(timeoutMs = 10_000) {
      return new Promise<number | null>((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`homestead CLI did not exit within ${timeoutMs}ms: homestead ${args.join(" ")}`))
        }, timeoutMs)
        proc.on("close", (code) => {
          clearTimeout(timer)
          resolvePromise(code)
        })
      })
    },
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const srv = createServer()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolvePromise(port))
    })
  })
}

export async function waitForHealth(port: number, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr = "not attempted"
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) })
      if (res.status === 200) return
    } catch (err) {
      lastErr = String(err)
    }
    await sleep(400)
  }
  throw new Error(`llama-server did not become healthy in ${timeoutMs}ms (last: ${lastErr})`)
}

export interface ChatCompletion {
  choices: Array<{ message?: { content: string }; finish_reason: string }>
  usage?: { completion_tokens?: number; total_tokens?: number; prompt_tokens?: number }
  model?: string
}

export async function chatCompletion(
  port: number,
  messages: Array<{ role: string; content: string }>,
  opts: { maxTokens?: number; temperature?: number; stream?: boolean } = {},
): Promise<{ status: number; data: ChatCompletion; elapsedMs: number }> {
  const start = performance.now()
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "homestead",
      messages,
      max_tokens: opts.maxTokens ?? 64,
      temperature: opts.temperature ?? 0,
      stream: opts.stream ?? false,
    }),
    signal: AbortSignal.timeout(120_000),
  })
  const data = (await res.json()) as ChatCompletion
  return { status: res.status, data, elapsedMs: performance.now() - start }
}
