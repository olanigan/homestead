import { spawn, execSync, type ChildProcess } from "node:child_process"
import type {
  ModelRecord,
  EngineAdapter,
  ServingProcess,
  EngineStatus,
  StreamEvent,
  ChatOptions,
  ServeOptions,
} from "../types.js"
import { globalEmitter } from "../observability/emitter.js"
import { addServer, removeServer } from "../core/server-state.js"
import { runningProcesses } from "./index.js"

interface SpawnedModalProcess {
  process: ChildProcess
  modelId: string
  endpoint: string
  lastStderr: string[]
}

export class ModalEngineAdapter implements EngineAdapter {
  kind = "modal" as const
  name = "Modal"
  priority = 30

  private defaultEndpoint: string | null = null
  private spawnedProcesses = new Map<string, SpawnedModalProcess>()

  constructor(defaultEndpoint?: string) {
    this.defaultEndpoint =
      defaultEndpoint ||
      process.env.MODAL_SERVE_ENDPOINT ||
      process.env.MODAL_ENDPOINT ||
      null
  }

  canHandle(model: ModelRecord): boolean {
    if (model.engine === "modal") return true
    if (model.source === "modal") return true
    if (model.metadata?.engine === "modal") return true
    if (model.metadata?.provider === "modal") return true
    if (typeof model.metadata?.modalEndpoint === "string") return true
    if (typeof model.metadata?.modal_endpoint === "string") return true
    if (typeof model.metadata?.modal_app === "string") return true
    if (typeof model.path === "string" && model.path.startsWith("modal://")) return true
    if (typeof model.path === "string" && (model.path.startsWith("https://") || model.path.startsWith("http://"))) return true
    return false
  }

  resolveEndpoint(model: ModelRecord): string | null {
    const fromMeta =
      (model.metadata?.modalEndpoint as string | undefined) ||
      (model.metadata?.modal_endpoint as string | undefined) ||
      (model.metadata?.endpoint as string | undefined)

    if (fromMeta && typeof fromMeta === "string" && fromMeta.trim()) {
      return this.normalizeEndpoint(fromMeta.trim())
    }

    if (
      typeof model.path === "string" &&
      (model.path.startsWith("https://") || model.path.startsWith("http://"))
    ) {
      return this.normalizeEndpoint(model.path.trim())
    }

    if (this.defaultEndpoint) {
      return this.normalizeEndpoint(this.defaultEndpoint)
    }

    if (typeof model.path === "string" && model.path.startsWith("modal://")) {
      // modal://app-name/func-name
      const appRef = model.path.replace(/^modal:\/\//, "")
      const envEndpoint = process.env[`MODAL_ENDPOINT_${appRef.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase()}`]
      if (envEndpoint) return this.normalizeEndpoint(envEndpoint)
    }

    return null
  }

  private normalizeEndpoint(raw: string): string {
    let clean = raw.replace(/\/+$/, "")
    if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
      clean = `https://${clean}`
    }
    if (!clean.endsWith("/v1")) {
      clean = `${clean}/v1`
    }
    return clean
  }

  async serve(model: ModelRecord, port?: number, opts?: ServeOptions): Promise<ServingProcess> {
    const existing = runningProcesses.get(model.id)
    if (existing) return existing

    let resolvedEndpoint = this.resolveEndpoint(model)
    let childProc: ChildProcess | undefined

    if (!resolvedEndpoint) {
      // On-demand modal deploy / serve if app path or module is specified in metadata
      const appPath = (model.metadata?.appPath as string) || (model.metadata?.app_path as string)
      if (appPath) {
        const spawned = this.spawnOnDemandModal(model.id, appPath, opts?.detach)
        childProc = spawned.process
        resolvedEndpoint = spawned.endpoint
      }
    }

    if (!resolvedEndpoint) {
      throw new Error(
        `Modal endpoint not configured for model "${model.name}". Provide metadata.modalEndpoint, ` +
        `a valid HTTPS URL path, or set the MODAL_SERVE_ENDPOINT environment variable.`
      )
    }

    // Healthcheck / warmup probe with timeout (allowing cold start)
    const timeoutMs = typeof model.metadata?.healthcheckTimeoutMs === "number" ? model.metadata.healthcheckTimeoutMs : 15_000
    if (model.metadata?.skipHealthcheck !== true) {
      try {
        await this.probeEndpointHealth(resolvedEndpoint, Math.min(timeoutMs, 30_000))
      } catch (err) {
        // Cold starts or custom auth on Modal might not immediately answer /health, but log and proceed if configured
        if (model.metadata?.requireHealthcheck === true) {
          throw new Error(`Modal endpoint health check failed for ${resolvedEndpoint}: ${err}`)
        }
      }
    }

    let parsedPort: number | undefined
    try {
      const url = new URL(resolvedEndpoint)
      parsedPort = url.port ? parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80
    } catch {
      parsedPort = port || 443
    }

    const sp: ServingProcess = {
      modelId: model.id,
      engineKind: this.kind,
      pid: childProc?.pid ?? 0,
      port: parsedPort,
      endpoint: resolvedEndpoint,
      startedAt: new Date().toISOString(),
    }

    runningProcesses.set(model.id, sp)
    addServer(sp)

    const active = globalEmitter.getDb().getActiveSessionByModel(model.id)
    const sessionId = active ? active.session_id : `modal-${model.id}-${Date.now()}`
    if (!active) {
      globalEmitter.modelLoaded(sessionId, model.id, model.name, this.kind, {
        endpoint: sp.endpoint,
        port: sp.port,
        pid: sp.pid,
        format: model.format,
      })
    }

    return sp
  }

  async stop(process: ServingProcess): Promise<void> {
    const spawned = this.spawnedProcesses.get(process.modelId)
    if (spawned) {
      this.spawnedProcesses.delete(process.modelId)
      try {
        spawned.process.kill("SIGTERM")
      } catch {}
    }

    runningProcesses.delete(process.modelId)
    removeServer(process.modelId)

    const existing = globalEmitter.getDb().getActiveSessionByModel(process.modelId)
    if (!existing) return

    globalEmitter.modelUnloaded(existing.session_id, process.modelId, process.modelId, this.kind, {
      reason: "scale_to_zero",
      duration_sec: (Date.now() - new Date(existing.first_ts).getTime()) / 1000,
      total_requests: 0,
    })
  }

  async status(): Promise<EngineStatus> {
    let modalVersion: string | null = null
    let healthy = false
    let runningCount = 0

    for (const [, proc] of runningProcesses) {
      if (proc.engineKind === this.kind) {
        runningCount++
      }
    }

    try {
      const out = execSync("modal --version 2>/dev/null", { encoding: "utf8", timeout: 3000 }).trim()
      if (out) {
        modalVersion = out
        healthy = true
      }
    } catch {
      // modal CLI not in PATH
    }

    if (this.defaultEndpoint) {
      try {
        const res = await fetch(`${this.defaultEndpoint}/health`, { signal: AbortSignal.timeout(3000) })
        if (res.ok) {
          healthy = true
        }
      } catch {}
    } else if (runningCount > 0) {
      healthy = true
    }

    return {
      kind: this.kind,
      running: healthy || runningCount > 0,
      modelsCount: runningCount,
      port: null,
      version: modalVersion ?? "serverless",
      healthy,
    }
  }

  async discover(): Promise<ModelRecord[]> {
    const discovered: ModelRecord[] = []
    const now = new Date().toISOString()

    const envModels = process.env.MODAL_MODELS
    if (envModels) {
      try {
        // Try parsing JSON list of model configs
        const parsed = JSON.parse(envModels)
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === "object" && item !== null && item.name && (item.endpoint || item.path)) {
              const endpoint = item.endpoint || item.path
              discovered.push({
                id: `modal-${item.name.toLowerCase().replace(/[^a-z0-9._-]/g, "-")}`,
                name: item.name,
                source: "modal",
                sourceId: endpoint,
                path: endpoint,
                sizeBytes: item.sizeBytes ?? 0,
                format: item.format ?? "safetensors",
                quantization: item.quantization ?? null,
                engine: "modal",
                status: "discovered",
                metadata: {
                  tags: ["weights"],
                  modalEndpoint: endpoint,
                  ...(item.metadata ?? {}),
                },
                discoveredAt: now,
                updatedAt: now,
              })
            }
          }
        }
      } catch {
        // Fall back to comma-separated list: name=endpoint,name2=endpoint2
        const entries = envModels.split(",")
        for (const entry of entries) {
          const [name, endpoint] = entry.split("=").map((s) => s.trim())
          if (name && endpoint) {
            discovered.push({
              id: `modal-${name.toLowerCase().replace(/[^a-z0-9._-]/g, "-")}`,
              name,
              source: "modal",
              sourceId: endpoint,
              path: endpoint,
              sizeBytes: 0,
              format: "safetensors",
              quantization: null,
              engine: "modal",
              status: "discovered",
              metadata: {
                tags: ["weights"],
                modalEndpoint: endpoint,
              },
              discoveredAt: now,
              updatedAt: now,
            })
          }
        }
      }
    }

    if (this.defaultEndpoint && discovered.length === 0) {
      discovered.push({
        id: "modal-default",
        name: "modal-default",
        source: "modal",
        sourceId: this.defaultEndpoint,
        path: this.defaultEndpoint,
        sizeBytes: 0,
        format: "safetensors",
        quantization: null,
        engine: "modal",
        status: "discovered",
        metadata: {
          tags: ["weights"],
          modalEndpoint: this.defaultEndpoint,
        },
        discoveredAt: now,
        updatedAt: now,
      })
    }

    return discovered
  }

  async *streamChat(
    modelId: string,
    messages: Array<{ role: string; content: string }>,
    opts: ChatOptions = {}
  ): AsyncGenerator<StreamEvent> {
    const sp = runningProcesses.get(modelId)
    if (!sp) throw new Error(`Modal engine process not serving for model ${modelId}`)

    const body = {
      model: modelId,
      messages,
      stream: true,
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.7,
      top_p: opts.topP ?? 0.95,
      ...(opts.stop ? { stop: opts.stop } : {}),
    }

    const endpoint = sp.endpoint.replace(/\/+$/, "")
    const url = endpoint.endsWith("/v1") ? `${endpoint}/chat/completions` : `${endpoint}/v1/chat/completions`

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Modal chat error (${res.status}): ${text}`)
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
          const obj = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>
          }
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
    const sp = runningProcesses.get(modelId)
    if (!sp) throw new Error(`Modal engine process not serving for model ${modelId}`)

    const t0 = Date.now()
    const endpoint = sp.endpoint.replace(/\/+$/, "")
    const url = endpoint.endsWith("/v1") ? `${endpoint}/chat/completions` : `${endpoint}/v1/chat/completions`

    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          temperature: 0,
          stream: false,
        }),
        signal: AbortSignal.timeout(60_000),
      })
    } catch (err) {
      throw new Error(`Modal warmup failed: ${err}`)
    }
    return Date.now() - t0
  }

  private spawnOnDemandModal(
    modelId: string,
    appPath: string,
    detach?: boolean
  ): { process: ChildProcess; endpoint: string } {
    const proc = spawn("modal", ["serve", appPath], detach ? { stdio: "ignore", detached: true } : { stdio: "pipe" })
    if (detach) proc.unref()

    const lastStderr: string[] = []
    const entry: SpawnedModalProcess = {
      process: proc,
      modelId,
      endpoint: "",
      lastStderr,
    }
    this.spawnedProcesses.set(modelId, entry)

    if (proc.stderr) {
      proc.stderr.on("data", (chunk: Buffer) => {
        const lines = chunk.toString("utf8").split("\n")
        for (const line of lines) {
          if (line) lastStderr.push(line)
          if (lastStderr.length > 50) lastStderr.shift()
        }
      })
    }

    const endpoint = this.defaultEndpoint || `https://custom-${modelId}.modal.run/v1`
    entry.endpoint = endpoint
    return { process: proc, endpoint }
  }

  private async probeEndpointHealth(endpoint: string, timeoutMs: number): Promise<void> {
    const base = endpoint.replace(/\/v1\/?$/, "")
    const probeUrls = [`${base}/health`, `${endpoint}/models`, `${base}/`]

    const deadline = Date.now() + timeoutMs
    let lastErr: unknown = null

    while (Date.now() < deadline) {
      for (const url of probeUrls) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
          if (res.ok || res.status === 404 || res.status === 401) {
            // Accessible endpoint reached
            return
          }
        } catch (err) {
          lastErr = err
        }
      }
      await new Promise((r) => setTimeout(r, 1000))
    }

    throw new Error(`Endpoint probe timed out after ${timeoutMs}ms: ${lastErr}`)
  }
}
