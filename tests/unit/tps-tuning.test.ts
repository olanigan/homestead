import { describe, it, expect, beforeAll, afterAll, spyOn } from "bun:test"
import { resolve, join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { getPhysicalCpuCount, LlamaCppAdapter } from "../../src/engines/index.js"
import { resolveProxyUrl, proxyToEngine } from "../../src/provider/proxy.js"
import { globalEmitter } from "../../src/observability/emitter.js"
import type { ModelRecord, ServeOptions } from "../../src/types.js"
import type { ResponsePayload } from "../../src/observability/types.js"

describe("TPS Tuning & Benchmarking", () => {
  let tmpDir: string
  let mockServer: Server
  let mockPort: number

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "homestead-tps-test-"))
    process.env.HOMESTEAD_OBS_DB_PATH = join(tmpDir, "obs.db")

    // Setup mock OpenAI/llama-server backend
    mockServer = createServer((req, res) => {
      let body = ""
      req.on("data", (chunk) => {
        body += chunk
      })
      req.on("end", () => {
        let isStream = false
        try {
          const parsed = JSON.parse(body)
          if (parsed.stream) isStream = true
        } catch {}

        if (isStream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          })
          res.write(`data: ${JSON.stringify({ id: "chunk-1", choices: [{ delta: { content: "Quantum" } }] })}\n\n`)
          setTimeout(() => {
            res.write(`data: ${JSON.stringify({ id: "chunk-2", choices: [{ delta: { content: " computing" } }] })}\n\n`)
            res.write(
              `data: ${JSON.stringify({
                id: "chunk-3",
                choices: [],
                usage: { prompt_tokens: 16, completion_tokens: 32, total_tokens: 48 },
              })}\n\n`
            )
            res.write("data: [DONE]\n\n")
            res.end()
          }, 15)
        } else {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(
            JSON.stringify({
              id: "chatcmpl-sync-test",
              object: "chat.completion",
              choices: [{ message: { role: "assistant", content: "Quantum computing is fascinating." } }],
              usage: { prompt_tokens: 24, completion_tokens: 48, total_tokens: 72 },
            })
          )
        }
      })
    })

    await new Promise<void>((resolvePromise) => {
      mockServer.listen(0, "127.0.0.1", () => {
        const addr = mockServer.address()
        if (typeof addr === "object" && addr !== null) {
          mockPort = addr.port
        }
        resolvePromise()
      })
    })
  })

  afterAll(async () => {
    await new Promise<void>((resolvePromise) => mockServer.close(() => resolvePromise()))
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  describe("getPhysicalCpuCount", () => {
    it("returns a number > 0", () => {
      const cpus = getPhysicalCpuCount()
      expect(typeof cpus).toBe("number")
      expect(cpus).toBeGreaterThan(0)
      expect(Number.isInteger(cpus)).toBe(true)
    })
  })

  describe("LlamaCppAdapter argv construction with ServeOptions", () => {
    const fakeModel: ModelRecord = {
      id: "test-model-1",
      name: "SmolLM2-135M-Instruct-Q4_K_M",
      source: "gguf-file",
      sourceId: "/path/to/model.gguf",
      path: "/path/to/model.gguf",
      sizeBytes: 1024 * 1024,
      format: "gguf",
      quantization: "Q4_K_M",
      engine: "llama.cpp",
      status: "discovered",
      metadata: { tags: ["weights"], parameter_count: "135M" },
      discoveredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    it("constructs default argv when no custom ServeOptions are passed", () => {
      const adapter = new LlamaCppAdapter()
      const argv = adapter.buildArgv(fakeModel, 8080)

      expect(argv).toContain("--model")
      expect(argv).toContain(resolve("/path/to/model.gguf"))
      expect(argv).toContain("--port")
      expect(argv[argv.indexOf("--port") + 1]).toBe("8080")
      expect(argv).toContain("--threads")
      expect(Number(argv[argv.indexOf("--threads") + 1])).toBeGreaterThan(0)
      expect(argv).toContain("-ngl")
      expect(argv[argv.indexOf("-ngl") + 1]).toBe("4") // Extracted from Q4_K_M
    })

    it("applies custom ServeOptions (threads, batchSize, ubatchSize, flashAttn, cacheTypeK, cacheTypeV, parallel, draftModel)", () => {
      const adapter = new LlamaCppAdapter()
      const customOpts: ServeOptions = {
        threads: 8,
        gpuLayers: 99,
        batchSize: 1024,
        ubatchSize: 256,
        flashAttn: true,
        cacheTypeK: "q8_0",
        cacheTypeV: "q4_0",
        parallel: 4,
        draftModel: "/models/draft-model.gguf",
      }

      const argv = adapter.buildArgv(fakeModel, 18799, customOpts)

      expect(argv).toContain("--threads")
      expect(argv[argv.indexOf("--threads") + 1]).toBe("8")
      expect(argv).toContain("-ngl")
      expect(argv[argv.indexOf("-ngl") + 1]).toBe("99")
      expect(argv).toContain("--batch-size")
      expect(argv[argv.indexOf("--batch-size") + 1]).toBe("1024")
      expect(argv).toContain("--ubatch-size")
      expect(argv[argv.indexOf("--ubatch-size") + 1]).toBe("256")
      expect(argv).toContain("--flash-attn")
      expect(argv[argv.indexOf("--flash-attn") + 1]).toBe("on")
      expect(argv).toContain("--cache-type-k")
      expect(argv[argv.indexOf("--cache-type-k") + 1]).toBe("q8_0")
      expect(argv).toContain("--cache-type-v")
      expect(argv[argv.indexOf("--cache-type-v") + 1]).toBe("q4_0")
      expect(argv).toContain("--parallel")
      expect(argv[argv.indexOf("--parallel") + 1]).toBe("4")
      expect(argv).toContain("--model-draft")
      expect(argv[argv.indexOf("--model-draft") + 1]).toBe(resolve("/models/draft-model.gguf"))
    })

    it("supports explicitly disabling flash attention", () => {
      const adapter = new LlamaCppAdapter()
      const argv = adapter.buildArgv(fakeModel, 8080, { flashAttn: false })

      expect(argv).toContain("--flash-attn")
      expect(argv[argv.indexOf("--flash-attn") + 1]).toBe("off")
    })
  })

  describe("resolveProxyUrl", () => {
    it("handles endpoints and paths with and without /v1 and trailing slashes", () => {
      expect(resolveProxyUrl("http://localhost:8080/v1", "/chat/completions")).toBe(
        "http://localhost:8080/v1/chat/completions"
      )
      expect(resolveProxyUrl("http://localhost:8080/v1/", "/chat/completions")).toBe(
        "http://localhost:8080/v1/chat/completions"
      )
      expect(resolveProxyUrl("http://localhost:8080/v1", "/v1/chat/completions")).toBe(
        "http://localhost:8080/v1/chat/completions"
      )
      expect(resolveProxyUrl("http://localhost:8080", "/v1/chat/completions")).toBe(
        "http://localhost:8080/v1/chat/completions"
      )
    })
  })

  describe("TPS response metrics in proxyToEngine", () => {
    it("computes completion_tps for non-streaming responses", async () => {
      const spy = spyOn(globalEmitter, "response")

      const res = await proxyToEngine(`http://127.0.0.1:${mockPort}`, "/chat/completions", {
        model: "test-model",
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      })

      expect(res.status).toBe(200)
      const json = (await res.json()) as { choices: Array<{ message: { content: string } }> }
      expect(json.choices[0].message.content).toBe("Quantum computing is fascinating.")

      expect(spy).toHaveBeenCalled()
      const lastCall = spy.mock.calls[spy.mock.calls.length - 1]
      const payload = lastCall[4] as ResponsePayload

      expect(payload).toBeDefined()
      expect(payload.input_tokens).toBe(24)
      expect(payload.output_tokens).toBe(48)
      expect(payload.total_tokens).toBe(72)
      expect(payload.completion_tps).toBeDefined()
      expect(payload.completion_tps).toBeGreaterThan(0)

      spy.mockRestore()
    })

    it("computes ttft_ms, prompt_tps, and completion_tps for streaming SSE responses", async () => {
      const spy = spyOn(globalEmitter, "response")

      const res = await proxyToEngine(`http://127.0.0.1:${mockPort}`, "/chat/completions", {
        model: "test-model",
        messages: [{ role: "user", content: "Explain quantum computing" }],
        stream: true,
      })

      expect(res.status).toBe(200)
      expect(res.headers.get("Content-Type")).toBe("text/event-stream")

      // Read stream to completion so emitResponse is triggered
      const reader = res.body?.getReader()
      expect(reader).toBeDefined()
      while (true) {
        const { done } = await reader!.read()
        if (done) break
      }

      expect(spy).toHaveBeenCalled()
      const lastCall = spy.mock.calls[spy.mock.calls.length - 1]
      const payload = lastCall[4] as ResponsePayload

      expect(payload).toBeDefined()
      expect(payload.input_tokens).toBe(16)
      expect(payload.output_tokens).toBe(32)
      expect(payload.total_tokens).toBe(48)
      expect(payload.ttft_ms).toBeDefined()
      expect(payload.ttft_ms).toBeGreaterThanOrEqual(0)
      expect(payload.prompt_tps).toBeDefined()
      expect(payload.prompt_tps).toBeGreaterThan(0)
      expect(payload.completion_tps).toBeDefined()
      expect(payload.completion_tps).toBeGreaterThan(0)

      spy.mockRestore()
    })
  })

  describe("ObsDb Benchmark Storage", () => {
    it("stores, queries, and filters benchmark records", () => {
      const db = globalEmitter.getDb()
      const record: BenchmarkRecord = {
        id: "bench-test-1",
        suite: "UI Studio Sweeps",
        model_id: "test-model-1",
        model_name: "SmolLM2-135M",
        label: "4 Threads, Batch 512",
        config: { threads: 4, batchSize: 512, flashAttn: true },
        workload: { promptLength: 100, maxTokens: 64, runs: 2 },
        prompt_tokens: 39,
        output_tokens: 32,
        total_tokens: 71,
        ttft_ms: 18.5,
        prompt_tps: 3109.9,
        completion_tps: 223.1,
        total_ms: 160,
        status: "completed",
        created_at: new Date().toISOString(),
      }

      const ok = db.insertBenchmark(record)
      expect(ok).toBe(true)

      const fetched = db.getBenchmarks({ suite: "UI Studio Sweeps" })
      expect(fetched.length).toBeGreaterThan(0)
      const found = fetched.find((b) => b.id === "bench-test-1")
      expect(found).toBeDefined()
      expect(found?.completion_tps).toBe(223.1)
      expect(found?.ttft_ms).toBe(18.5)
      expect(found?.config.threads).toBe(4)
    })
  })
})
