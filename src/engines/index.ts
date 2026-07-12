import { spawn, execSync } from "node:child_process"
import { createInterface } from "node:readline"
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { createServer } from "node:net"
import type { ModelRecord, EngineAdapter, ServingProcess, EngineStatus, StreamEvent, ChatOptions } from "../types.js"
import { globalEmitter } from "../observability/emitter.js"

const runningProcesses = new Map<string, ServingProcess>()
const PID_DIR = join(homedir(), ".homestead")
const PID_FILE = join(PID_DIR, "llama-server.pid")

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

function writePidFile(pid: number): void {
  mkdirSync(PID_DIR, { recursive: true })
  writeFileSync(PID_FILE, String(pid), "utf8")
}

function clearPidFile(): void {
  try { unlinkSync(PID_FILE) } catch {}
}

function cleanupStalePidFile(): void {
  try {
    if (!existsSync(PID_FILE)) return
    const raw = readFileSync(PID_FILE, "utf8").trim()
    if (!raw) { clearPidFile(); return }
    const pid = parseInt(raw, 10)
    if (isNaN(pid)) { clearPidFile(); return }
    if (!pidAlive(pid)) { clearPidFile(); return }
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
    clearPidFile()
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

  async serve(model: ModelRecord, _port: number): Promise<ServingProcess> {
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

export class LlamaCppAdapter implements EngineAdapter {
  kind = "llama.cpp" as const
  name = "llama.cpp"
  priority = 20
  private resolved: { bin: string; args: string[] } | null
  process: ReturnType<typeof spawn> | null = null
  port = 0
  host = "127.0.0.1"
  private _currentModel: ModelRecord | null = null
  lastStderr: string[] = []
  private _watchdogInterval: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.resolved = resolveLlamaBin()
  }

  get isAvailable(): boolean {
    return this.resolved !== null
  }

  get endpoint(): string {
    return this.port ? `http://${this.host}:${this.port}/v1` : ""
  }

  get alive(): boolean {
    return this.process !== null && this.process.exitCode === null
  }

  canHandle(model: ModelRecord): boolean {
    return model.format === "gguf" && model.source !== "ollama"
  }

  async serve(model: ModelRecord, port: number): Promise<ServingProcess> {
    const existing = runningProcesses.get(model.id)
    if (existing) return existing

    if (!this.resolved) {
      throw new Error(
        "llama.cpp binary not found. Install via: curl -LsSf https://llama.app/install.sh | sh\n" +
        "Or: brew install llama.cpp"
      )
    }

    cleanupStalePidFile()

    this._currentModel = model
    this.lastStderr = []
    this.port = port || findFreePort()
    this.modelPath = resolve(model.path)

    const resolved = resolveLlamaBin()
    this.resolved = resolved ?? this.resolved

    const argv: string[] = [
      ...this.resolved.args,
      "--model", this.modelPath,
      "--host", this.host,
      "--port", String(this.port),
      "--ctx-size", "4096",
      "--jinja",
      "--no-webui",
    ]

    const ngl = model.quantization ? parseInt(model.quantization.replace(/[^0-9]/g, "")) || 99 : 99
    argv.push("-ngl", String(ngl))

    this.process = spawn(this.resolved.bin, argv, { stdio: "pipe" })
    writePidFile(this.process.pid ?? 0)

    this.tailStderr(this.process)

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
      pid: this.process.pid ?? 0,
      port: this.port,
      endpoint: this.endpoint,
      startedAt: new Date().toISOString(),
    }
    runningProcesses.set(model.id, sp)

    globalEmitter.modelLoaded(sessionId, model.id, model.name, this.kind, {
      endpoint: sp.endpoint,
      port: sp.port,
      pid: sp.pid,
      format: model.format,
    })

    try {
      await this.waitForHealth(90_000)
    } catch (err) {
      runningProcesses.delete(model.id)
      globalEmitter.modelUnloaded(sessionId, model.id, model.name, this.kind, {
        reason: "health_timeout",
        duration_sec: 0,
        total_requests: 0,
      })
      throw err
    }

    this.process.on("exit", () => {
      runningProcesses.delete(model.id)
      globalEmitter.modelUnloaded(sessionId, model.id, model.name, this.kind, {
        reason: "process_exit",
        duration_sec: (Date.now() - new Date(sp.startedAt).getTime()) / 1000,
        total_requests: 0,
      })
    })

    return sp
  }

  async stop(sp: ServingProcess): Promise<void> {
    this.stopWatchdog()
    const proc = this.process
    if (!proc) {
      try { process.kill(sp.pid, "SIGTERM") } catch {}
      runningProcesses.delete(sp.modelId)
      return
    }
    this.process = null

    try { process.kill(proc.pid!, "SIGTERM") } catch {}
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && proc.exitCode === null) {
      await new Promise((r) => setTimeout(r, 100))
    }
    if (proc.exitCode === null) {
      try { process.kill(proc.pid!, "SIGKILL") } catch {}
    }
    clearPidFile()
    runningProcesses.delete(sp.modelId)
    const sessionId = `llamacpp-${sp.modelId}-${new Date(sp.startedAt).getTime()}`
    globalEmitter.modelUnloaded(sessionId, sp.modelId, sp.modelId, this.kind, {
      reason: "user_stop",
      duration_sec: (Date.now() - new Date(sp.startedAt).getTime()) / 1000,
      total_requests: 0,
    })
  }

  async status(): Promise<EngineStatus> {
    const targetPort = this.port || 8080
    try {
      const res = await fetch(`http://127.0.0.1:${targetPort}/health`, { signal: AbortSignal.timeout(2000) })
      return { kind: this.kind, running: res.ok, modelsCount: 0, port: targetPort, version: null, healthy: res.ok }
    } catch {
      return { kind: this.kind, running: false, modelsCount: 0, port: targetPort, version: null, healthy: false }
    }
  }

  async discover(): Promise<ModelRecord[]> {
    const { scanGgufFiles } = await import("../scanners/gguf-file.js")
    return scanGgufFiles()
  }

  async *streamChat(
    messages: Array<{ role: string; content: string }>,
    opts: ChatOptions = {},
  ): AsyncGenerator<StreamEvent> {
    if (!this.alive) throw new Error("llama-server not running")

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

    const res = await fetch(`${this.endpoint}/chat/completions`, {
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

  async weightInit(): Promise<number> {
    if (!this.alive) throw new Error("llama-server not running")
    const t0 = Date.now()
    try {
      await fetch(`${this.endpoint}/chat/completions`, {
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

  private tailStderr(proc: ReturnType<typeof spawn>): void {
    if (!proc.stderr) return
    const rl = createInterface({ input: proc.stderr })
    rl.on("line", (line) => {
      this.lastStderr.push(line)
      if (this.lastStderr.length > 80) this.lastStderr.shift()
    })
  }

  private async waitForHealth(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let lastErr: unknown = null
    while (Date.now() < deadline) {
      if (this.process?.exitCode !== null && this.process !== null) {
        const code = this.process.exitCode
        const tail = this.lastStderr.slice(-30).join("\n") || "(no stderr)"
        clearPidFile()
        throw new Error(
          `llama-server exited early code=${code}\n----- stderr tail -----\n${tail}`
        )
      }
      try {
        const res = await fetch(`http://${this.host}:${this.port}/health`, {
          signal: AbortSignal.timeout(2_000),
        })
        if (res.status === 200) return
      } catch (err) {
        lastErr = String(err)
      }
      await new Promise((r) => setTimeout(r, 400))
    }
    const tail = this.lastStderr.slice(-30).join("\n") || "(no stderr)"
    clearPidFile()
    throw new Error(
      `llama-server did not become ready in ${(timeoutMs / 1000).toFixed(0)}s (last: ${lastErr})\n----- stderr tail -----\n${tail}`
    )
  }

  private startWatchdog(parentPid: number): void {
    this._watchdogInterval = setInterval(() => {
      try {
        process.kill(parentPid, 0)
      } catch {
        for (const [, sp] of runningProcesses) {
          if (sp.engineKind === this.kind) {
            this.stop(sp)
            break
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

  private modelPath = ""
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
    return Array.from(runningProcesses.values())
  }
}

export const engineManager = new EngineManager()

