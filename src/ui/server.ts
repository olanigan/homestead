import { Hono } from "hono"
import { serveStatic } from "hono/bun"
import { serve } from "bun"
import { join } from "node:path"
import type { Registry } from "../core/registry.js"
import { discoverAll } from "../core/scanner.js"
import { engineManager } from "../engines/index.js"
import { globalEmitter } from "../observability/emitter.js"
import { createProviderApp } from "../provider/homestead.js"

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
      const proc = await engine.serve(model, 8080)
      registry.updateStatus(model.id, "serving")
      return c.json(proc)
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
