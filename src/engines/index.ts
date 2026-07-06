import { spawn, execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ModelRecord, EngineAdapter, ServingProcess, EngineStatus } from "../types.js"
import { globalEmitter } from "../observability/emitter.js"

const runningProcesses = new Map<string, ServingProcess>()

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
    } catch { /* best effort */ }
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

function resolveLlamaBin(): { bin: string; args: string[] } | null {
  for (const name of ["llama", "llama-server"]) {
    try {
      const resolved = execSync(`which ${name} 2>/dev/null`, { encoding: "utf8" }).trim()
      if (resolved) return { bin: resolved, args: name === "llama" ? ["serve"] : [] }
    } catch { /* not on PATH */ }
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

export class LlamaCppAdapter implements EngineAdapter {
  kind = "llama.cpp" as const
  name = "llama.cpp"
  priority = 20
  private resolved: { bin: string; args: string[] } | null

  constructor() {
    this.resolved = resolveLlamaBin()
  }

  get isAvailable(): boolean {
    return this.resolved !== null
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

    const proc = spawn(this.resolved.bin, [
      ...this.resolved.args,
      "-m", model.path,
      "--port", String(port),
      "--host", "127.0.0.1",
      "-ngl", "99",
      "-c", "4096",
    ], { stdio: "pipe" })

    const sessionId = `llamacpp-${model.id}-${Date.now()}`
    const sp: ServingProcess = {
      modelId: model.id,
      engineKind: this.kind,
      pid: proc.pid || 0,
      port,
      endpoint: `http://127.0.0.1:${port}/v1`,
      startedAt: new Date().toISOString(),
    }
    runningProcesses.set(model.id, sp)

    globalEmitter.modelLoaded(sessionId, model.id, model.name, this.kind, {
      endpoint: sp.endpoint,
      port: sp.port,
      pid: sp.pid,
      format: model.format,
    })

    proc.on("exit", () => {
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
    try {
      process.kill(sp.pid, "SIGTERM")
    } catch { /* best effort */ }
    runningProcesses.delete(sp.modelId)
    const sessionId = `llamacpp-${sp.modelId}-${new Date(sp.startedAt).getTime()}`
    globalEmitter.modelUnloaded(sessionId, sp.modelId, sp.modelId, this.kind, {
      reason: "user_stop",
      duration_sec: (Date.now() - new Date(sp.startedAt).getTime()) / 1000,
      total_requests: 0,
    })
  }

  async status(): Promise<EngineStatus> {
    try {
      const res = await fetch("http://127.0.0.1:8080/health", { signal: AbortSignal.timeout(2000) })
      return { kind: this.kind, running: res.ok, modelsCount: 0, port: 8080, version: null, healthy: res.ok }
    } catch {
      return { kind: this.kind, running: false, modelsCount: 0, port: 8080, version: null, healthy: false }
    }
  }

  async discover(): Promise<ModelRecord[]> {
    const { scanGgufFiles } = await import("../scanners/gguf-file.js")
    return scanGgufFiles()
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
    return Array.from(runningProcesses.values())
  }
}

export const engineManager = new EngineManager()
