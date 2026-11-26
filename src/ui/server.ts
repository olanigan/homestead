import { Hono } from "hono"
import { serveStatic } from "hono/bun"
import { serve } from "bun"
import { join } from "node:path"
import type { Registry } from "../core/registry.js"
import { discoverAll } from "../core/scanner.js"
import { engineManager } from "../engines/index.js"
import { globalEmitter } from "../observability/emitter.js"
import { createProviderApp } from "../provider/homestead.js"
import { resolveProxyUrl } from "../provider/proxy.js"
import type { ServeOptions } from "../types.js"
import type { BenchmarkRecord } from "../observability/types.js"

export async function serveUi(
  port: number,
  registry: Registry,
): Promise<void> {
  const app = new Hono()

  app.route("/v1", createProviderApp(registry))
  const uiDir = join(import.meta.dir, "../../dist/ui")

  app.get("/api/models", (c) => {
    const source = c.req.query("source")
    const models = source ? registry.list(source as any) : registry.list()
    return c.json(models)
  })

  app.get("/api/models/:id", (c) => {
    const model = registry.get(c.req.param("id"))
    if (!model) return c.json({ error: "not found" }, 404)
    return c.json(model)
  })

  app.post("/api/models/:id/serve", async (c) => {
    const model = registry.get(c.req.param("id"))
    if (!model) return c.json({ error: "not found" }, 404)
    const tags = (model.metadata?.tags as string[]) || []
    if (tags.includes("vocab")) return c.json({ error: "vocabulary-only file, not a model with weights" }, 400)
    if (tags.includes("cloud")) return c.json({ error: "cloud-only model, not available locally" }, 400)
    if (tags.includes("incomplete")) return c.json({ error: "download is incomplete, missing files" }, 400)
    const engine = engineManager.selectEngine(model)
    if (!engine) return c.json({ error: `no engine for format ${model.format}` }, 400)
    try {
      let serveOpts: ServeOptions | undefined
      let port = 8080
      try {
        const body = (await c.req.json()) as Record<string, unknown>
        if (body && typeof body === "object") {
          if (typeof body.port === "number") port = body.port
          serveOpts = {
            threads: typeof body.threads === "number" ? body.threads : undefined,
            gpuLayers: typeof body.gpuLayers === "number" ? body.gpuLayers : undefined,
            batchSize: typeof body.batchSize === "number" ? body.batchSize : undefined,
            ubatchSize: typeof body.ubatchSize === "number" ? body.ubatchSize : undefined,
            flashAttn: typeof body.flashAttn === "boolean" ? body.flashAttn : undefined,
            cacheTypeK: typeof body.cacheTypeK === "string" ? body.cacheTypeK : undefined,
            cacheTypeV: typeof body.cacheTypeV === "string" ? body.cacheTypeV : undefined,
            parallel: typeof body.parallel === "number" ? body.parallel : undefined,
            draftModel: typeof body.draftModel === "string" ? body.draftModel : undefined,
          }
        }
      } catch {}
      const proc = await engine.serve(model, port, serveOpts)
      registry.updateStatus(model.id, "serving")
      return c.json(proc)
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  app.post("/api/models/:id/bench", async (c) => {
    const model = registry.get(c.req.param("id"))
    if (!model) return c.json({ error: "not found" }, 404)
    const tags = (model.metadata?.tags as string[]) || []
    if (tags.includes("vocab")) return c.json({ error: "vocabulary-only file, not a model with weights" }, 400)
    if (tags.includes("cloud")) return c.json({ error: "cloud-only model, not available locally" }, 400)
    if (tags.includes("incomplete")) return c.json({ error: "download is incomplete, missing files" }, 400)
    const engine = engineManager.selectEngine(model)
    if (!engine) return c.json({ error: `no engine for format ${model.format}` }, 400)

    try {
      let body: any = {}
      try {
        body = (await c.req.json()) || {}
      } catch {}

      const prompt = body.prompt || "Explain quantum computing in 3 simple paragraphs."
      const maxTokens = body.maxTokens || 64
      const runs = Math.max(1, body.runs || 2)
      const serveOpts: ServeOptions = {
        threads: body.threads !== undefined ? Number(body.threads) : undefined,
        gpuLayers: body.gpuLayers !== undefined ? Number(body.gpuLayers) : undefined,
        batchSize: body.batchSize !== undefined ? Number(body.batchSize) : undefined,
        ubatchSize: body.ubatchSize !== undefined ? Number(body.ubatchSize) : undefined,
        flashAttn: body.flashAttn !== undefined ? Boolean(body.flashAttn) : undefined,
      }

      const benchPort = 18800 + Math.floor(Math.random() * 80)
      const proc = await engine.serve(model, benchPort, serveOpts)
      const targetUrl = resolveProxyUrl(proc.endpoint, "/v1/chat/completions")

      const runResults: Array<{
        ttftMs: number
        promptTps: number
        completionTps: number
        promptTokens: number
        completionTokens: number
        totalMs: number
      }> = []

      try {
        for (let i = 0; i < runs; i++) {
          const startedAt = Date.now()
          const res = await fetch(targetUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: model.name,
              messages: [{ role: "user", content: prompt }],
              max_tokens: maxTokens,
              temperature: 0,
              stream: true,
              stream_options: { include_usage: true },
            }),
          })

          if (!res.ok || !res.body) {
            throw new Error(`Inference request failed with HTTP ${res.status}: ${await res.text()}`)
          }

          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let firstTokenTs = 0
          let completionTokens = 0
          let promptTokens = Math.max(1, Math.round(prompt.length / 4))

          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            const chunk = decoder.decode(value, { stream: true })
            const lines = chunk.split("\n")
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue
              const dataStr = line.slice(6).trim()
              if (dataStr === "[DONE]") continue
              try {
                const parsed = JSON.parse(dataStr)
                if (parsed.choices?.[0]?.delta?.content) {
                  if (!firstTokenTs) firstTokenTs = Date.now()
                  completionTokens++
                }
                if (parsed.usage) {
                  if (parsed.usage.prompt_tokens) promptTokens = parsed.usage.prompt_tokens
                  if (parsed.usage.completion_tokens) completionTokens = parsed.usage.completion_tokens
                }
              } catch {}
            }
          }

          const totalMs = Date.now() - startedAt
          const ttftMs = firstTokenTs ? firstTokenTs - startedAt : totalMs
          const genMs = Math.max(1, totalMs - ttftMs)
          const promptTps = ttftMs > 0 ? Number(((promptTokens / (ttftMs / 1000))).toFixed(2)) : 0
          const completionTps = genMs > 0 ? Number(((completionTokens / (genMs / 1000))).toFixed(2)) : 0

          runResults.push({ ttftMs, promptTps, completionTps, promptTokens, completionTokens, totalMs })
        }
      } finally {
        await engine.stop(proc)
      }

      const avgTtft = runResults.reduce((acc, r) => acc + r.ttftMs, 0) / runResults.length
      const avgPromptTps = runResults.reduce((acc, r) => acc + r.promptTps, 0) / runResults.length
      const avgCompletionTps = runResults.reduce((acc, r) => acc + r.completionTps, 0) / runResults.length
      const avgTotalMs = runResults.reduce((acc, r) => acc + r.totalMs, 0) / runResults.length
      const lastRun = runResults[runResults.length - 1]

      const record: BenchmarkRecord = {
        id: `bench-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        suite: body.suite || "UI Studio",
        model_id: model.id,
        model_name: model.name,
        label: body.label || (runs === 1 ? `Single Run (${maxTokens} tokens)` : `${runs} Runs Avg (-t ${serveOpts.threads ?? "auto"})`),
        config: { ...serveOpts },
        workload: { promptLength: prompt.length, maxTokens, runs },
        prompt_tokens: lastRun?.promptTokens,
        output_tokens: lastRun?.completionTokens,
        total_tokens: (lastRun?.promptTokens ?? 0) + (lastRun?.completionTokens ?? 0),
        ttft_ms: avgTtft,
        prompt_tps: avgPromptTps,
        completion_tps: avgCompletionTps,
        total_ms: avgTotalMs,
        status: "completed",
        created_at: new Date().toISOString(),
      }

      globalEmitter.getDb().insertBenchmark(record)

      return c.json({
        record,
        runs: runResults,
        avgTtft,
        avgPromptTps,
        avgCompletionTps,
        avgTotalMs,
      })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  app.post("/api/models/:id/stop", async (c) => {
    const model = registry.get(c.req.param("id"))
    if (!model) return c.json({ error: "not found" }, 404)
    const engine = engineManager.selectEngine(model)
    if (!engine) return c.json({ error: "no engine" }, 400)
    const processes = engineManager.getRunningProcesses().filter((p) => p.modelId === model.id)
    for (const p of processes) await engine.stop(p)
    registry.updateStatus(model.id, "stopped")
    return c.json({ stopped: true })
  })

  app.post("/api/discover", async (c) => {
    const result = await discoverAll(registry)
    return c.json(result)
  })

  app.get("/api/status", async (c) => {
    const statuses = await engineManager.allStatuses()
    const processes = engineManager.getRunningProcesses()
    const stats = registry.stats()
    return c.json({ engines: statuses, processes, stats })
  })

  app.get("/api/stats", (c) => {
    return c.json(registry.stats())
  })

  app.get("/api/obs/stats", (c) => {
    return c.json(globalEmitter.getDb().stats())
  })

  app.get("/api/obs/sessions", (c) => {
    const limit = parseInt(c.req.query("limit") || "50", 10)
    return c.json(globalEmitter.getDb().getSessions(limit))
  })

  app.get("/api/obs/events", (c) => {
    const sessionId = c.req.query("session_id")
    const since = c.req.query("since")
    if (sessionId) {
      return c.json(globalEmitter.getDb().getSessionEvents(sessionId, since))
    }
    return c.json(globalEmitter.getDb().getRecentEvents(100))
  })

  app.get("/api/benchmarks", (c) => {
    const suite = c.req.query("suite")
    const modelId = c.req.query("model_id")
    const limit = parseInt(c.req.query("limit") || "100", 10)
    return c.json(globalEmitter.getDb().getBenchmarks({ suite, model_id: modelId, limit }))
  })

  app.post("/api/benchmarks", async (c) => {
    try {
      const record = await c.req.json()
      const ok = globalEmitter.getDb().insertBenchmark(record)
      return c.json({ success: ok }, ok ? 201 : 400)
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  app.delete("/api/benchmarks", (c) => {
    const suite = c.req.query("suite")
    globalEmitter.getDb().deleteBenchmarks(suite)
    return c.json({ deleted: true })
  })

  app.get("/api/obs/stream", (c) => {
    const filterPool = c.req.query("pool")
    const filterTag = c.req.query("tag")
    const filterSession = c.req.query("session_id")
    const stream = new ReadableStream({
      start(controller) {
        const unsub = globalEmitter.subscribe((event) => {
          if (filterPool && event.pool !== filterPool) return
          if (filterTag && !event.tags.includes(filterTag)) return
          if (filterSession && event.session_id !== filterSession) return
          const frame = `event: event\ndata: ${JSON.stringify(event)}\n\n`
          try { controller.enqueue(new TextEncoder().encode(frame)) } catch { unsub() }
        })
        c.req.raw.signal.addEventListener("abort", unsub)
      },
    })
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })
  })

  try {
    const { readdirSync } = await import("node:fs")
    readdirSync(join(uiDir, "assets"))
    app.use("/*", serveStatic({ root: uiDir }))
  } catch {
    app.get("/*", (c) => c.text("Web UI not built. Run: cd src/ui/frontend && npm run build\n"))
  }

  const server = serve({
    fetch: app.fetch,
    port,
    // Bun's default idleTimeout is 10s. Local model auto-serve (cold-loading
    // a multi-GB GGUF on CPU) and long generations routinely exceed that,
    // which kills the connection mid-request and surfaces to clients (e.g.
    // Pi) as a generic "Connection error." with no indication why. This is
    // a localhost dev tool, not a public-facing server, so disable the
    // idle timeout rather than picking another arbitrary ceiling.
    idleTimeout: 0,
  })

  console.log(`  UI: http://localhost:${port}`)
  console.log(`  API: http://localhost:${port}/api/`)
  console.log(`  Provider: http://localhost:${port}/v1/`)

  process.on("SIGINT", () => {
    server.stop()
    process.exit(0)
  })
}
