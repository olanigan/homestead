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
import { runningProcesses } from "./state.js"
import { resolveProviderApiKey } from "../core/credentials.js"

export class RemoteOpenAIAdapter implements EngineAdapter {
  kind = "remote" as const
  name = "Remote OpenAI / DeepSeek / OpenRouter"
  priority = 35

  canHandle(model: ModelRecord): boolean {
    if (model.engine === "remote" || model.engine === "deepseek" || model.engine === "openrouter") return true
    if (model.source === "deepseek" || model.source === "openrouter" || model.source === "remote") return true
    if (model.metadata?.provider === "deepseek" || model.metadata?.provider === "openrouter" || model.metadata?.provider === "remote") return true
    if (model.metadata?.engine === "remote" || model.metadata?.engine === "deepseek" || model.metadata?.engine === "openrouter") return true
    if (typeof model.metadata?.remoteEndpoint === "string" || typeof model.metadata?.remote_endpoint === "string") return true
    if (typeof model.path === "string" && (model.path.startsWith("deepseek://") || model.path.startsWith("openrouter://"))) return true
    return false
  }

  resolveEndpoint(model: ModelRecord): string {
    const fromMeta =
      (model.metadata?.remoteEndpoint as string | undefined) ||
      (model.metadata?.remote_endpoint as string | undefined) ||
      (model.metadata?.endpoint as string | undefined)

    if (fromMeta && typeof fromMeta === "string" && fromMeta.trim()) {
      return this.normalizeEndpoint(fromMeta.trim())
    }

    if (model.source === "deepseek" || model.metadata?.provider === "deepseek" || (typeof model.path === "string" && model.path.startsWith("deepseek://"))) {
      return process.env.DEEPSEEK_ENDPOINT ? this.normalizeEndpoint(process.env.DEEPSEEK_ENDPOINT) : "https://api.deepseek.com/v1"
    }

    if (model.source === "openrouter" || model.metadata?.provider === "openrouter" || (typeof model.path === "string" && model.path.startsWith("openrouter://"))) {
      return process.env.OPENROUTER_ENDPOINT ? this.normalizeEndpoint(process.env.OPENROUTER_ENDPOINT) : "https://openrouter.ai/api/v1"
    }

    if (typeof model.path === "string" && (model.path.startsWith("https://") || model.path.startsWith("http://"))) {
      return this.normalizeEndpoint(model.path.trim())
    }

    return "https://api.deepseek.com/v1"
  }

  resolveApiKey(model: ModelRecord): string | null {
    if (typeof model.metadata?.apiKey === "string" && model.metadata.apiKey.trim()) {
      return model.metadata.apiKey.trim()
    }
    if (typeof model.metadata?.api_key === "string" && model.metadata.api_key.trim()) {
      return model.metadata.api_key.trim()
    }

    const provider = (model.metadata?.provider as string) || model.source || "deepseek"
    return resolveProviderApiKey(provider)
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

  async serve(model: ModelRecord, port?: number, _opts?: ServeOptions): Promise<ServingProcess> {
    const existing = runningProcesses.get(model.id)
    if (existing) return existing

    const resolvedEndpoint = this.resolveEndpoint(model)
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
      pid: 0,
      port: parsedPort,
      endpoint: resolvedEndpoint,
      startedAt: new Date().toISOString(),
    }

    runningProcesses.set(model.id, sp)
    addServer(sp)

    const active = globalEmitter.getDb().getActiveSessionByModel(model.id)
    const sessionId = active ? active.session_id : `remote-${model.id}-${Date.now()}`
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
    const deepseekKey = resolveProviderApiKey("deepseek")
    const openrouterKey = resolveProviderApiKey("openrouter")
    const isAvailable = Boolean(deepseekKey || openrouterKey || process.env.REMOTE_ENDPOINT)

    let runningCount = 0
    for (const [, proc] of runningProcesses) {
      if (proc.engineKind === this.kind) {
        runningCount++
      }
    }

    return {
      kind: this.kind,
      running: isAvailable || runningCount > 0,
      modelsCount: runningCount,
      port: null,
      version: "remote-gateway",
      healthy: isAvailable,
    }
  }

  async discover(): Promise<ModelRecord[]> {
    const discovered: ModelRecord[] = []
    const now = new Date().toISOString()

    const deepseekKey = resolveProviderApiKey("deepseek")
    if (deepseekKey) {
      discovered.push(
        {
          id: "deepseek-chat",
          name: "deepseek-chat",
          source: "deepseek",
          sourceId: "https://api.deepseek.com/v1",
          path: "deepseek://deepseek-chat",
          sizeBytes: 0,
          format: "safetensors",
          quantization: null,
          engine: "remote",
          status: "discovered",
          metadata: {
            tags: ["weights", "cloud"],
            provider: "deepseek",
            remoteEndpoint: "https://api.deepseek.com/v1",
            context_length: 65536,
          },
          discoveredAt: now,
          updatedAt: now,
        },
        {
          id: "deepseek-reasoner",
          name: "deepseek-reasoner",
          source: "deepseek",
          sourceId: "https://api.deepseek.com/v1",
          path: "deepseek://deepseek-reasoner",
          sizeBytes: 0,
          format: "safetensors",
          quantization: null,
          engine: "remote",
          status: "discovered",
          metadata: {
            tags: ["weights", "cloud", "reasoning"],
            provider: "deepseek",
            remoteEndpoint: "https://api.deepseek.com/v1",
            context_length: 65536,
          },
          discoveredAt: now,
          updatedAt: now,
        }
      )
    }

    const openrouterKey = resolveProviderApiKey("openrouter")
    if (openrouterKey) {
      discovered.push({
        id: "openrouter-qwen-2-5-coder-32b",
        name: "qwen/qwen-2.5-coder-32b-instruct",
        source: "openrouter",
        sourceId: "https://openrouter.ai/api/v1",
        path: "openrouter://qwen/qwen-2.5-coder-32b-instruct",
        sizeBytes: 0,
        format: "safetensors",
        quantization: null,
        engine: "remote",
        status: "discovered",
        metadata: {
          tags: ["weights", "cloud"],
          provider: "openrouter",
          remoteEndpoint: "https://openrouter.ai/api/v1",
          context_length: 32768,
        },
        discoveredAt: now,
        updatedAt: now,
      })
    }

    const envRemoteModels = process.env.REMOTE_MODELS
    if (envRemoteModels) {
      try {
        const parsed = JSON.parse(envRemoteModels)
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && item.name && (item.endpoint || item.path)) {
              const endpoint = item.endpoint || item.path
              discovered.push({
                id: `remote-${item.name.toLowerCase().replace(/[^a-z0-9._-]/g, "-")}`,
                name: item.name,
                source: "remote",
                sourceId: endpoint,
                path: endpoint,
                sizeBytes: 0,
                format: "safetensors",
                quantization: null,
                engine: "remote",
                status: "discovered",
                metadata: {
                  tags: ["weights", "cloud"],
                  remoteEndpoint: endpoint,
                  ...(item.metadata ?? {}),
                },
                discoveredAt: now,
                updatedAt: now,
              })
            }
          }
        }
      } catch {}
    }

    return discovered
  }

  async *streamChat(
    modelId: string,
    messages: Array<{ role: string; content: string }>,
    opts: ChatOptions = {}
  ): AsyncGenerator<StreamEvent> {
    const sp = runningProcesses.get(modelId)
    if (!sp) throw new Error(`Remote engine process not serving for model ${modelId}`)

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

    const headers: Record<string, string> = { "Content-Type": "application/json" }
    const apiKey = resolveProviderApiKey(modelId.includes("deepseek") ? "deepseek" : modelId.includes("openrouter") ? "openrouter" : "remote")
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Remote chat error (${res.status}): ${text}`)
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
    if (!sp) throw new Error(`Remote engine process not serving for model ${modelId}`)

    const t0 = Date.now()
    const endpoint = sp.endpoint.replace(/\/+$/, "")
    const url = endpoint.endsWith("/v1") ? `${endpoint}/chat/completions` : `${endpoint}/v1/chat/completions`

    const headers: Record<string, string> = { "Content-Type": "application/json" }
    const apiKey = resolveProviderApiKey(modelId.includes("deepseek") ? "deepseek" : modelId.includes("openrouter") ? "openrouter" : "remote")
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`
    }

    try {
      await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          temperature: 0,
          stream: false,
        }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (err) {
      throw new Error(`Remote warmup failed: ${err}`)
    }
    return Date.now() - t0
  }
}
