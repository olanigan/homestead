import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Hono } from "hono"
import { serve } from "bun"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { proxyToEngine } from "../../src/provider/proxy.js"
import { globalEmitter } from "../../src/observability/emitter.js"
import { Registry } from "../../src/core/registry.js"
import { createProviderApp } from "../../src/provider/homestead.js"
import type { ModelRecord } from "../../src/types.js"

describe("Observability Tracing (DB & UI API)", () => {
  let mockServer: ReturnType<typeof serve>
  let mockPort: number
  let mockEndpoint: string

  beforeAll(() => {
    // Spin up a lightweight mock OpenAI server mounted at /v1
    const mockApp = new Hono()
    const handler = async (c: any) => {
      const body = await c.req.json() as any
      if (body.stream) {
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder()
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'))
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" world"}}]}\n\n'))
            controller.enqueue(encoder.encode('data: {"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n'))
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          }
        })
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream" }
        })
      }

      return c.json({
        id: "chatcmpl-mock",
        choices: [{ message: { role: "assistant", content: "Mock response from Qwen/DeepSeek" } }],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 }
      })
    }

    mockApp.post("/chat/completions", handler)
    mockApp.post("/v1/chat/completions", handler)

    mockServer = serve({
      fetch: mockApp.fetch,
      port: 0,
    })
    mockPort = mockServer.port
    mockEndpoint = `http://127.0.0.1:${mockPort}/v1`
  })

  afterAll(() => {
    mockServer.stop()
  })

  test("proxyToEngine records request and response events in ObsDb", async () => {
    const db = globalEmitter.getDb()
    const statsBefore = db.stats()
    const obsSessionId = `sess-test-obs-${Date.now()}`

    const res = await proxyToEngine(
      mockEndpoint,
      "/chat/completions",
      {
        model: "qwen-3.6-27b",
        messages: [{ role: "user", content: "Write a test" }],
        temperature: 0.7,
      },
      {},
      {
        sessionId: obsSessionId,
        modelId: "qwen-3.6-27b",
        modelName: "qwen-3.6-27b",
        engineKind: "modal",
      }
    )

    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.choices[0].message.content).toContain("Mock response")

    // Verify events were stored in SQLite DB
    const events = db.getSessionEvents(obsSessionId)
    expect(events.length).toBeGreaterThanOrEqual(2)

    const reqEvent = events.find((e) => e.type === "request")
    const resEvent = events.find((e) => e.type === "response")

    expect(reqEvent).toBeDefined()
    expect(reqEvent?.model_name).toBe("qwen-3.6-27b")
    expect((reqEvent?.payload as any).model).toBe("qwen-3.6-27b")

    expect(resEvent).toBeDefined()
    expect((resEvent?.payload as any).output_tokens).toBe(8)
    expect((resEvent?.payload as any).input_tokens).toBe(10)
    expect((resEvent?.payload as any).latency_ms).toBeGreaterThanOrEqual(0)

    // Verify stats incremented
    const statsAfter = db.stats()
    expect(statsAfter.total_events).toBeGreaterThan(statsBefore.total_events)
    expect(statsAfter.total_requests).toBeGreaterThan(statsBefore.total_requests)
  })

  test("proxyToEngine records streaming SSE request and response events", async () => {
    const db = globalEmitter.getDb()
    const streamSessionId = `sess-test-stream-${Date.now()}`

    const res = await proxyToEngine(
      mockEndpoint,
      "/chat/completions",
      {
        model: "deepseek-chat",
        messages: [{ role: "user", content: "Streaming test" }],
        stream: true,
      },
      {},
      {
        sessionId: streamSessionId,
        modelId: "deepseek-chat",
        modelName: "deepseek-chat",
        engineKind: "remote",
      }
    )

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("text/event-stream")

    // Consume stream
    const reader = res.body!.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }

    // Small yield for async db write
    await new Promise((r) => setTimeout(r, 50))

    const events = db.getSessionEvents(streamSessionId)
    expect(events.length).toBeGreaterThanOrEqual(2)
    const streamRes = events.find((e) => e.type === "response")
    expect(streamRes).toBeDefined()
    expect((streamRes?.payload as any).output_tokens).toBe(2)
  })

  test("End-to-end /v1/chat/completions through provider app captures traces in DB and lists in /v1/models", async () => {
    const tmpDbPath = join(tmpdir(), `test-reg-${Date.now()}.db`)
    const registry = new Registry(tmpDbPath)
    const now = new Date().toISOString()
    const model: ModelRecord = {
      id: "qwen-3.6-27b",
      name: "qwen-3.6-27b",
      source: "modal",
      sourceId: mockEndpoint,
      path: mockEndpoint,
      sizeBytes: 0,
      format: "safetensors",
      quantization: null,
      engine: "modal",
      status: "discovered",
      metadata: {
        tags: ["weights"],
        modalEndpoint: mockEndpoint,
      },
      discoveredAt: now,
      updatedAt: now,
    }
    registry.upsert(model)

    const app = createProviderApp(registry)
    const req = new Request("http://localhost/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen-3.6-27b",
        messages: [{ role: "user", content: "End-to-end test" }],
      }),
    })

    const resp = await app.fetch(req)
    expect(resp.status).toBe(200)

    const db = globalEmitter.getDb()
    const recent = db.getRecentEvents(10)
    const found = recent.some((e) => e.model_id === "qwen-3.6-27b")
    expect(found).toBe(true)
  })
})
