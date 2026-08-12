import { spawn, execSync } from "node:child_process"
import { createInterface } from "node:readline"
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { createServer } from "node:net"
import type { ModelRecord, EngineAdapter, ServingProcess, EngineStatus, StreamEvent, ChatOptions, ServeOptions } from "../types.js"
import { globalEmitter } from "../observability/emitter.js"
import { addServer, removeServer, loadServers } from "../core/server-state.js"

const runningProcesses = new Map<string, ServingProcess>()
const PID_DIR = join(homedir(), ".homestead")

// PID files are keyed per model.id, not a single shared file — a shared file cannot
// distinguish "stale PID from a crashed session" from "a different model that is still
// legitimately serving," so cleaning it up before starting a second concurrent model would
// kill the first model's live process. See epic-002-foundation.yaml:story-212.
function pidFilePathFor(modelId: string): string {
  const safe = modelId.replace(/[^a-zA-Z0-9._-]/g, "_")
  return join(PID_DIR, `llama-server-${safe}.pid`)
}

// Fallback when a model has no discovered context_length.
const DEFAULT_CTX_SIZE = 4096
// Upper bound so a model reporting a huge native window (e.g. 262144, 1048576)
// doesn't blow up KV-cache memory on typical local hardware.
const MAX_CTX_SIZE = 32768

export function resolveCtxSize(model: ModelRecord): number {
  const metaCtx = model.metadata?.context_length
  if (typeof metaCtx === "number" && metaCtx > 0) {
    return Math.min(metaCtx, MAX_CTX_SIZE)
  }
  return DEFAULT_CTX_SIZE
}

function resolveLlamaBin(): { bin: string; args: string[] } | null {
  for (const name of ["llama", "llama-server"]) {
    try {
      const resolved = execSync(`which ${name} 2>/dev/null`, { encoding: "utf8" }).trim()
      if (resolved) return { bin: resolved, args: name === "llama" ? ["serve"] : [] }
    } catch {}
  }
  const knownPaths: Array<{ bin: string; args: string[] }> = [
    { bin: join(homedir(), ".local", "bin", "llama"), args: ["serve"] },
    { bin: join(homedir(), ".unsloth", "llama.cpp", "build", "bin", "llama"), args: ["serve"] },
    { bin: join(homedir(), ".unsloth", "llama.cpp", "build", "bin", "llama-server"), args: [] },
  ]
  for (const c of knownPaths) {
    if (existsSync(c.bin)) return c
  }
  return null
}

async function resolveModelPath(model: ModelRecord): Promise<string> {
  if (model.format === "gguf" && model.source === "hf-hub" && !/\.gguf$/i.test(model.path)) {
    try {
      const { resolveHfGgufPath } = await import("../scanners/hf-hub.js")
      return resolveHfGgufPath(model.path) ?? model.path
    } catch {}
  }
  return model.path
}

function findFreePort(start = 18766, end = 18800): number {
  for (let port = start; port <= end; port++) {
    const server = createServer()
    try {
      server.listen(port, "127.0.0.1")
      server.close()
      return port
    } catch {
      server.close()
    }
  }
  const server = createServer()
  server.listen(0, "127.0.0.1")
  const port = (server.address() as { port: number }).port
  server.close()
  return port
}

function pidAlive(pid: number): boolean {
  if (!(pid > 0)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function processNameMatches(pid: number, needle: string): boolean {
  try {
    const out = execSync(`ps -p ${pid} -o comm=`, { encoding: "utf8", timeout: 3000 }).trim().toLowerCase()
    return out.includes(needle.toLowerCase())
  } catch {
    return false
  }
}

function writePidFile(modelId: string, pid: number): void {
  mkdirSync(PID_DIR, { recursive: true })
  writeFileSync(pidFilePathFor(modelId), String(pid), "utf8")
}

function clearPidFile(modelId: string): void {
  try { unlinkSync(pidFilePathFor(modelId)) } catch {}
}

// Cleans up a stale PID left behind by a crashed/killed previous session for THIS specific
// model.id only — never touches another model's PID file, so it can never kill a different
// model's still-alive process the way a single shared PID file did.
function cleanupStalePidFile(modelId: string): void {
  const pidFile = pidFilePathFor(modelId)
  try {
    if (!existsSync(pidFile)) return
    const raw = readFileSync(pidFile, "utf8").trim()
    if (!raw) { clearPidFile(modelId); return }
    const pid = parseInt(raw, 10)
    if (isNaN(pid)) { clearPidFile(modelId); return }
    if (!pidAlive(pid)) { clearPidFile(modelId); return }
    if (processNameMatches(pid, "llama-server") || processNameMatches(pid, "llama")) {
      try {
        process.kill(pid, "SIGTERM")
        const deadline = Date.now() + 2000
        while (Date.now() < deadline && pidAlive(pid)) {
          new Promise((r) => setTimeout(r, 100))
        }
        if (pidAlive(pid)) process.kill(pid, "SIGKILL")
      } catch {}
    }
    clearPidFile(modelId)
  } catch {}
}

export class OllamaAdapter implements EngineAdapter {
  kind = "ollama" as const
  name = "Ollama"
  priority = 10
  private endpoint: string

  constructor(endpoint?: string) {
    this.endpoint = endpoint || process.env.OLLAMA_HOST || "http://127.0.0.1:11434"
  }

  canHandle(model: ModelRecord): boolean {
    return model.engine === "ollama" || model.source === "ollama"
  }

  async serve(model: ModelRecord, _port: number, _opts?: ServeOptions): Promise<ServingProcess> {
    const existing = runningProcesses.get(model.id)
    if (existing) return existing

    const modelName = model.name
    const port = parseInt(new URL(this.endpoint).port) || 11434

    try {
      const loadRes = await fetch(`${this.endpoint}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelName, stream: false }),
        signal: AbortSignal.timeout(60000),
      })
      if (!loadRes.ok) {
        const text = await loadRes.text()
        throw new Error(`Ollama load failed (${loadRes.status}): ${text}`)
      }
      const body = await loadRes.json() as { done: boolean; load_duration?: number }
      if (!body.done) {
        throw new Error("Ollama model load did not complete")
      }

      const sp: ServingProcess = {
        modelId: model.id,
        engineKind: this.kind,
        pid: 0,
        port,
        endpoint: `${this.endpoint}/v1`,
        startedAt: new Date().toISOString(),
      }
      runningProcesses.set(model.id, sp)
      addServer(sp)

      const active = globalEmitter.getDb().getActiveSessionByModel(model.id)
      const sessionId = active ? active.session_id : `ollama-${model.id}-${Date.now()}`
      if (!active) {
        globalEmitter.modelLoaded(sessionId, model.id, modelName, this.kind, {
          endpoint: sp.endpoint,
          port: sp.port,
          pid: sp.pid,
          format: model.format,
        })
      }

      return sp
    } catch (err) {
      globalEmitter.error(`ollama-${model.id}-${Date.now()}`, model.id, modelName, model.engine ?? this.kind, {
        message: `Failed to start Ollama model: ${err}`,
        code: "SERVE_ERROR",
      })
      throw new Error(`Failed to start Ollama model ${modelName}: ${err}`)
    }
  }

  async stop(process: ServingProcess): Promise<void> {
    const modelName = process.modelId.replace(/^ollama-/, "").replace(/-/g, ":")
    try {
      await fetch(`${this.endpoint}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelName, keep_alive: "0m", stream: false }),
        signal: AbortSignal.timeout(5000),
      })
    } catch {}
    runningProcesses.delete(process.modelId)
    removeServer(process.modelId)
    const existing = globalEmitter.getDb().getActiveSessionByModel(process.modelId)
    if (!existing) return
    globalEmitter.modelUnloaded(existing.session_id, process.modelId, process.modelId, this.kind, {
      reason: "user_stop",
      duration_sec: (Date.now() - new Date(existing.first_ts).getTime()) / 1000,
      total_requests: 0,
    })
  }

  async status(): Promise<EngineStatus> {
    try {
      const res = await fetch(`${this.endpoint}/api/tags`, { signal: AbortSignal.timeout(2000) })
      if (!res.ok) return { kind: this.kind, running: false, modelsCount: 0, port: 11434, version: null, healthy: false, error: `HTTP ${res.status}` }
      const data = await res.json() as { models?: unknown[] }
      return { kind: this.kind, running: true, modelsCount: data.models?.length || 0, port: 11434, version: null, healthy: true }
    } catch (err) {
      return { kind: this.kind, running: false, modelsCount: 0, port: 11434, version: null, healthy: false, error: String(err) }
    }
  }

  async discover(): Promise<ModelRecord[]> {
    const { scanOllama } = await import("../scanners/ollama.js")
    return scanOllama()
  }
}

interface LlamaCppProcess {
  process: ReturnType<typeof spawn>
  port: number
  host: string
  model: ModelRecord
  modelPath: string
  lastStderr: string[]
}

export class LlamaCppAdapter implements EngineAdapter {
  kind = "llama.cpp" as const
  name = "llama.cpp"
  priority = 20
  private resolved: { bin: string; args: string[] } | null
  // Per-model state, keyed by model.id — NOT instance fields. A single set of instance
  // fields (this.process/this.port/...) meant a second concurrent serve() call silently
  // clobbered the first model's bookkeeping (and, via the old shared PID file, could
  // actively kill it). See epic-002-foundation.yaml:story-212 for the full writeup.
  private processes = new Map<string, LlamaCppProcess>()
  private _watchdogInterval: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.resolved = resolveLlamaBin()
  }

  get isAvailable(): boolean {
    return this.resolved !== null
  }

  /** Number of models this adapter currently has a live process handle for. */
  get servedCount(): number {
    return this.processes.size
  }

  private endpointFor(entry: LlamaCppProcess): string {
    return entry.port ? `http://${entry.host}:${entry.port}/v1` : ""
  }

  private isAliveEntry(entry: LlamaCppProcess): boolean {
    return entry.process.exitCode === null
  }

  canHandle(model: ModelRecord): boolean {
    return model.format === "gguf" && model.source !== "ollama"
  }

  async serve(model: ModelRecord, port: number, opts?: ServeOptions): Promise<ServingProcess> {
    const existing = runningProcesses.get(model.id)
    if (existing) return existing
    const existingLocal = this.processes.get(model.id)
    if (existingLocal && this.isAliveEntry(existingLocal)) {
      const sp: ServingProcess = {
        modelId: model.id,
        engineKind: this.kind,
        pid: existingLocal.process.pid ?? 0,
        port: existingLocal.port,
        endpoint: this.endpointFor(existingLocal),
        startedAt: new Date().toISOString(),
      }
      return sp
    }

    if (!this.resolved) {
      throw new Error(
        "llama.cpp binary not found. Install via: curl -LsSf https://llama.app/install.sh | sh\n" +
        "Or: brew install llama.cpp"
      )
    }

    // Scoped to THIS model.id only — cannot touch a different, still-alive model's process.
    cleanupStalePidFile(model.id)

    const host = "127.0.0.1"
    const resolvedPort = port || findFreePort()
    const modelPath = resolve(await resolveModelPath(model))

    const resolved = resolveLlamaBin()
    this.resolved = resolved ?? this.resolved

    const argv: string[] = [
      ...this.resolved.args,
      "--model", modelPath,
      "--host", host,
      "--port", String(resolvedPort),
      "--ctx-size", String(resolveCtxSize(model)),
      "--jinja",
      "--no-webui",
    ]

    const ngl = model.quantization ? parseInt(model.quantization.replace(/[^0-9]/g, "")) || 99 : 99
    argv.push("-ngl", String(ngl))

    const proc = spawn(this.resolved.bin, argv, opts?.detach ? { stdio: "ignore", detached: true } : { stdio: "pipe" })
    if (opts?.detach) proc.unref()

    const entry: LlamaCppProcess = { process: proc, port: resolvedPort, host, model, modelPath, lastStderr: [] }
    this.processes.set(model.id, entry)
    writePidFile(model.id, proc.pid ?? 0)

    this.tailStderr(model.id, proc)

    if (typeof process !== "undefined") {
      const parentPid = parseInt(process.env.MINICPM_PARENT_PID ?? "", 10)
      if (parentPid > 0) {
        this.startWatchdog(parentPid)
      }
    }

    const sessionId = `llamacpp-${model.id}-${Date.now()}`
    const sp: ServingProcess = {
      modelId: model.id,
      engineKind: this.kind,
      pid: proc.pid ?? 0,
      port: resolvedPort,
      endpoint: this.endpointFor(entry),
      startedAt: new Date().toISOString(),
    }
    runningProcesses.set(model.id, sp)
    addServer(sp)

    globalEmitter.modelLoaded(sessionId, model.id, model.name, this.kind, {
      endpoint: sp.endpoint,
      port: sp.port,
      pid: sp.pid,
      format: model.format,
    })

    try {
      await this.waitForHealth(model.id, 90_000)
    } catch (err) {
      this.processes.delete(model.id)
      runningProcesses.delete(model.id)
      globalEmitter.modelUnloaded(sessionId, model.id, model.name, this.kind, {
        reason: "health_timeout",
        duration_sec: 0,
        total_requests: 0,
      })
      throw err
    }

    proc.on("exit", () => {
      this.processes.delete(model.id)
      runningProcesses.delete(model.id)
      removeServer(model.id)
      if (this.processes.size === 0) this.stopWatchdog()
      globalEmitter.modelUnloaded(sessionId, model.id, model.name, this.kind, {
        reason: "process_exit",
        duration_sec: (Date.now() - new Date(sp.startedAt).getTime()) / 1000,
        total_requests: 0,
      })
    })

    return sp
  }

  async stop(sp: ServingProcess): Promise<void> {
    const entry = this.processes.get(sp.modelId)
    if (entry) {
      this.processes.delete(sp.modelId)
      const proc = entry.process
      try { process.kill(proc.pid!, "SIGTERM") } catch {}
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline && proc.exitCode === null) {
        await new Promise((r) => setTimeout(r, 100))
      }
      if (proc.exitCode === null) {
        try { process.kill(proc.pid!, "SIGKILL") } catch {}
      }
    } else if (sp.pid > 0) {
      // No local handle (e.g. this adapter instance didn't spawn it — restored from
      // server-state.ts after a restart). Fall back to killing by the ServingProcess's
      // own recorded pid, never a different entry's pid.
      try { process.kill(sp.pid, "SIGTERM") } catch {}
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline && pidAlive(sp.pid)) {
        await new Promise((r) => setTimeout(r, 100))
      }
      if (pidAlive(sp.pid)) {
        try { process.kill(sp.pid, "SIGKILL") } catch {}
      }
    }
    clearPidFile(sp.modelId)
    removeServer(sp.modelId)
    runningProcesses.delete(sp.modelId)
    if (this.processes.size === 0) this.stopWatchdog()
    const sessionId = `llamacpp-${sp.modelId}-${new Date(sp.startedAt).getTime()}`
    globalEmitter.modelUnloaded(sessionId, sp.modelId, sp.modelId, this.kind, {
      reason: "user_stop",
      duration_sec: (Date.now() - new Date(sp.startedAt).getTime()) / 1000,
      total_requests: 0,
    })
  }

  async status(): Promise<EngineStatus> {
    // EngineStatus is a single-object shape (one port/health), but this adapter can now
    // serve several models at once — modelsCount reflects the real concurrent count;
    // the health probe below is only against the most-recently-served entry, since there's
    // no per-model slot in EngineStatus to report more than one health check in.
    const entries = [...this.processes.values()]
    const latest = entries[entries.length - 1]
    const targetPort = latest?.port || 8080
    try {
      const res = await fetch(`http://127.0.0.1:${targetPort}/health`, { signal: AbortSignal.timeout(2000) })
      return { kind: this.kind, running: res.ok, modelsCount: this.processes.size, port: targetPort, version: null, healthy: res.ok }
    } catch {
      return { kind: this.kind, running: false, modelsCount: this.processes.size, port: targetPort, version: null, healthy: false }
    }
  }

  async discover(): Promise<ModelRecord[]> {
    const { scanGgufFiles } = await import("../scanners/gguf-file.js")
    return scanGgufFiles()
  }

  async *streamChat(
    modelId: string,
    messages: Array<{ role: string; content: string }>,
    opts: ChatOptions = {},
  ): AsyncGenerator<StreamEvent> {
    const entry = this.processes.get(modelId)
    if (!entry || !this.isAliveEntry(entry)) throw new Error(`llama-server not running for model ${modelId}`)

    const body = {
      model: "homestead",
      messages,
      stream: true,
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.7,
      top_p: opts.topP ?? 0.95,
      top_k: opts.topK ?? 0,
      repeat_penalty: opts.repeatPenalty ?? 1.05,
      ...(opts.stop ? { stop: opts.stop } : {}),
    }

    const res = await fetch(`${this.endpointFor(entry)}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`llama-server chat error (${res.status}): ${text}`)
    }

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      const lines = buf.split("\n")
      buf = lines.pop() ?? ""

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith("data:")) continue
        const payload = trimmed.slice(5).trim()
        if (payload === "[DONE]") return

        try {
          const obj = JSON.parse(payload)
          const delta = obj.choices?.[0]?.delta ?? {}
          const reasoning = delta.reasoning_content
          if (reasoning) yield { kind: "reasoning" as const, text: reasoning }
          const content = delta.content
          if (content) yield { kind: "content" as const, text: content }
        } catch {}
      }
    }
  }

  async weightInit(modelId: string): Promise<number> {
    const entry = this.processes.get(modelId)
    if (!entry || !this.isAliveEntry(entry)) throw new Error(`llama-server not running for model ${modelId}`)
    const t0 = Date.now()
    try {
      await fetch(`${this.endpointFor(entry)}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "homestead",
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 1,
          temperature: 0,
          stream: false,
        }),
        signal: AbortSignal.timeout(60_000),
      })
    } catch (err) {
      throw new Error(`Warmup failed: ${err}`)
    }
    return Date.now() - t0
  }

  private tailStderr(modelId: string, proc: ReturnType<typeof spawn>): void {
    if (!proc.stderr) return
    const rl = createInterface({ input: proc.stderr })
    rl.on("line", (line) => {
      const entry = this.processes.get(modelId)
      if (!entry) return
      entry.lastStderr.push(line)
      if (entry.lastStderr.length > 80) entry.lastStderr.shift()
    })
  }

  private async waitForHealth(modelId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let lastErr: unknown = null
    while (Date.now() < deadline) {
      const entry = this.processes.get(modelId)
      if (!entry) {
        throw new Error(`llama-server process for ${modelId} was removed before it became healthy`)
      }
      if (entry.process.exitCode !== null) {
        const code = entry.process.exitCode
        const tail = entry.lastStderr.slice(-30).join("\n") || "(no stderr)"
        clearPidFile(modelId)
        throw new Error(
          `llama-server exited early code=${code}\n----- stderr tail -----\n${tail}`
        )
      }
      try {
        const res = await fetch(`http://${entry.host}:${entry.port}/health`, {
          signal: AbortSignal.timeout(2_000),
        })
        if (res.status === 200) return
      } catch (err) {
        lastErr = String(err)
      }
      await new Promise((r) => setTimeout(r, 400))
    }
    const entry = this.processes.get(modelId)
    const tail = entry?.lastStderr.slice(-30).join("\n") || "(no stderr)"
    clearPidFile(modelId)
    throw new Error(
      `llama-server did not become ready in ${(timeoutMs / 1000).toFixed(0)}s (last: ${lastErr})\n----- stderr tail -----\n${tail}`
    )
  }

  // One shared watchdog covers ALL concurrently-tracked processes — on parent death it
  // must stop every one of them, not just the first match it happens to find.
  private startWatchdog(parentPid: number): void {
    if (this._watchdogInterval) return
    this._watchdogInterval = setInterval(() => {
      try {
        process.kill(parentPid, 0)
      } catch {
        for (const [, sp] of runningProcesses) {
          if (sp.engineKind === this.kind) {
            this.stop(sp)
          }
        }
      }
    }, 2_000)
  }

  private stopWatchdog(): void {
    if (this._watchdogInterval) {
      clearInterval(this._watchdogInterval)
      this._watchdogInterval = null
    }
  }
}

export class EngineManager {
  private adapters: EngineAdapter[] = []

  constructor() {
    this.adapters.push(new OllamaAdapter())
    this.adapters.push(new LlamaCppAdapter())
  }

  register(adapter: EngineAdapter): void {
    this.adapters.push(adapter)
  }

  selectEngine(model: ModelRecord): EngineAdapter | null {
    const candidates = this.adapters
      .filter((a) => a.canHandle(model))
      .sort((a, b) => b.priority - a.priority)
    return candidates[0] || null
  }

  getAdapter(kind: string): EngineAdapter | undefined {
    return this.adapters.find((a) => a.kind === kind)
  }

  async allStatuses(): Promise<EngineStatus[]> {
    const statuses = await Promise.all(this.adapters.map((a) => a.status()))
    return statuses
  }

  getRunningProcesses(): ServingProcess[] {
    const memory = Array.from(runningProcesses.values())
    const memoryIds = new Set(memory.map((p) => p.modelId))
    const persisted = loadServers().filter((p) => !memoryIds.has(p.modelId))
    return [...memory, ...persisted]
  }
}

export const engineManager = new EngineManager()

