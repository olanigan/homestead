import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { ModalEngineAdapter } from "../../src/engines/modal.js"
import { EngineManager, runningProcesses } from "../../src/engines/index.js"
import { proxyToEngine, resolveProxyUrl } from "../../src/provider/proxy.js"
import { ensureServingProcess } from "../../src/provider/serve-model.js"
import { Registry } from "../../src/core/registry.js"
import type { ModelRecord, ServingProcess } from "../../src/types.js"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function makeModel(overrides: Partial<ModelRecord> = {}): ModelRecord {
  const now = new Date().toISOString()
  return {
    id: "modal-test-model-1",
    name: "qwen-2.5-72b-instruct-modal",
    source: "modal",
    sourceId: "https://modal-workspace--qwen-serve.modal.run",
    path: "https://modal-workspace--qwen-serve.modal.run",
    sizeBytes: 0,
    format: "safetensors",
    quantization: null,
    engine: "modal",
    status: "discovered",
    metadata: {
      tags: ["weights"],
      modalEndpoint: "https://modal-workspace--qwen-serve.modal.run/v1",
    },
    discoveredAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe("ModalEngineAdapter", () => {
  let adapter: ModalEngineAdapter

  beforeEach(() => {
    adapter = new ModalEngineAdapter("https://default--test-endpoint.modal.run")
  })

  afterEach(() => {
    runningProcesses.clear()
  })

  describe("canHandle", () => {
    test("returns true for engine === 'modal'", () => {
      expect(adapter.canHandle(makeModel({ engine: "modal" }))).toBe(true)
    })

    test("returns true for source === 'modal'", () => {
      expect(adapter.canHandle(makeModel({ source: "modal", engine: null }))).toBe(true)
    })

    test("returns true when modalEndpoint is present in metadata", () => {
      expect(adapter.canHandle(makeModel({ engine: null, source: "imported", metadata: { modalEndpoint: "https://test.modal.run" } }))).toBe(true)
    })

    test("returns true when modal_endpoint is present in metadata", () => {
      expect(adapter.canHandle(makeModel({ engine: null, source: "imported", metadata: { modal_endpoint: "https://test.modal.run" } }))).toBe(true)
    })

    test("returns true for modal:// path", () => {
      expect(adapter.canHandle(makeModel({ engine: null, source: "imported", path: "modal://my-app/serve" }))).toBe(true)
    })

    test("returns true for metadata.engine === 'modal'", () => {
      expect(adapter.canHandle(makeModel({ engine: null, source: "imported", metadata: { engine: "modal" } }))).toBe(true)
    })

    test("returns false for local GGUF model with llama.cpp", () => {
      const localModel = makeModel({
        source: "hf-hub",
        engine: "llama.cpp",
        format: "gguf",
        path: "/local/model.gguf",
        metadata: {},
      })
      expect(adapter.canHandle(localModel)).toBe(false)
    })
  })

  describe("resolveEndpoint", () => {
    test("resolves and normalizes endpoint from metadata.modalEndpoint", () => {
      const model = makeModel({ metadata: { modalEndpoint: "https://workspace--app.modal.run" } })
      expect(adapter.resolveEndpoint(model)).toBe("https://workspace--app.modal.run/v1")
    })

    test("resolves and normalizes endpoint from model.path", () => {
      const model = makeModel({ path: "https://custom--app.modal.run/v1", metadata: {} })
      expect(adapter.resolveEndpoint(model)).toBe("https://custom--app.modal.run/v1")
    })

    test("falls back to default endpoint", () => {
      const model = makeModel({ path: "", metadata: {} })
      expect(adapter.resolveEndpoint(model)).toBe("https://default--test-endpoint.modal.run/v1")
    })
  })

  describe("serve and stop lifecycle", () => {
    test("serves a remote Modal model and creates a ServingProcess", async () => {
      const model = makeModel({
        metadata: {
          modalEndpoint: "https://workspace--vllm-serve.modal.run/v1",
          skipHealthcheck: true,
        },
      })

      const proc = await adapter.serve(model, 8080)

      expect(proc.modelId).toBe(model.id)
      expect(proc.engineKind).toBe("modal")
      expect(proc.endpoint).toBe("https://workspace--vllm-serve.modal.run/v1")
      expect(proc.port).toBe(443)
      expect(proc.pid).toBe(0)
      expect(runningProcesses.get(model.id)).toBeDefined()
    })

    test("reuses existing serving process on subsequent serve call", async () => {
      const model = makeModel({
        metadata: {
          modalEndpoint: "https://workspace--vllm-serve.modal.run/v1",
          skipHealthcheck: true,
        },
      })

      const proc1 = await adapter.serve(model, 8080)
      const proc2 = await adapter.serve(model, 8080)

      expect(proc1).toBe(proc2)
    })

    test("stops serving process and handles scale-to-zero", async () => {
      const model = makeModel({
        metadata: {
          modalEndpoint: "https://workspace--vllm-serve.modal.run/v1",
          skipHealthcheck: true,
        },
      })

      const proc = await adapter.serve(model, 8080)
      expect(runningProcesses.has(model.id)).toBe(true)

      await adapter.stop(proc)
      expect(runningProcesses.has(model.id)).toBe(false)
    })

    test("throws descriptive error when no endpoint can be resolved", async () => {
      const noDefaultAdapter = new ModalEngineAdapter(undefined)
      const model = makeModel({ path: "", metadata: {} })

      expect(noDefaultAdapter.serve(model, 8080)).rejects.toThrow("Modal endpoint not configured")
    })
  })

  describe("status and discover", () => {
    test("status reports running when processes or default endpoint are active", async () => {
      const status = await adapter.status()
      expect(status.kind).toBe("modal")
      expect(status.version).toBeDefined()
    })

    test("discover parses MODAL_MODELS JSON environment variable", async () => {
      const prevEnv = process.env.MODAL_MODELS
      process.env.MODAL_MODELS = JSON.stringify([
        {
          name: "DeepSeek-R1-Distill-Qwen-32B",
          endpoint: "https://workspace--deepseek-r1.modal.run/v1",
          format: "safetensors",
        },
      ])

      try {
        const discovered = await adapter.discover()
        expect(discovered.length).toBe(1)
        expect(discovered[0].name).toBe("DeepSeek-R1-Distill-Qwen-32B")
        expect(discovered[0].engine).toBe("modal")
        expect(discovered[0].metadata.modalEndpoint).toBe("https://workspace--deepseek-r1.modal.run/v1")
      } finally {
        if (prevEnv) process.env.MODAL_MODELS = prevEnv
        else delete process.env.MODAL_MODELS
      }
    })
  })

  describe("warmup ping / weightInit", () => {
    test("weightInit calculates warmup latency against mock endpoint", async () => {
      const model = makeModel({
        id: "modal-warmup-test",
        metadata: { modalEndpoint: "https://mock.modal.run/v1", skipHealthcheck: true },
      })
      const sp: ServingProcess = {
        modelId: model.id,
        engineKind: "modal",
        endpoint: "http://127.0.0.1:18899/v1",
        startedAt: new Date().toISOString(),
      }
      runningProcesses.set(model.id, sp)

      const server = Bun.serve({
        port: 18899,
        fetch(_req) {
          return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), {
            headers: { "Content-Type": "application/json" },
          })
        },
      })

      try {
        const elapsed = await adapter.weightInit(model.id)
        expect(elapsed).toBeGreaterThanOrEqual(0)
      } finally {
        server.stop(true)
      }
    })
  })
})

describe("EngineManager with ModalEngineAdapter", () => {
  test("selectEngine chooses Modal for Modal models due to priority", () => {
    const manager = new EngineManager()
    const modalModel = makeModel({ engine: "modal" })
    const selected = manager.selectEngine(modalModel)
    expect(selected?.kind).toBe("modal")
  })

  test("getAdapter returns ModalEngineAdapter for 'modal'", () => {
    const manager = new EngineManager()
    const adapter = manager.getAdapter("modal")
    expect(adapter).toBeDefined()
    expect(adapter?.kind).toBe("modal")
  })
})

describe("Proxy & Remote Serving Wiring", () => {
  test("resolveProxyUrl handles trailing slashes and /v1 prefix cleanly", () => {
    expect(resolveProxyUrl("https://modal.run/v1", "/chat/completions")).toBe("https://modal.run/v1/chat/completions")
    expect(resolveProxyUrl("https://modal.run/v1/", "/chat/completions")).toBe("https://modal.run/v1/chat/completions")
    expect(resolveProxyUrl("https://modal.run/v1", "/v1/chat/completions")).toBe("https://modal.run/v1/chat/completions")
    expect(resolveProxyUrl("https://modal.run", "/v1/chat/completions")).toBe("https://modal.run/v1/chat/completions")
  })

  test("proxyToEngine returns 502 response when remote endpoint is unreachable", async () => {
    const res = await proxyToEngine("http://127.0.0.1:59999/v1", "/chat/completions", { model: "test" })
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: { code: string; type: string } }
    expect(body.error.code).toBe("engine_unreachable")
  })

  test("ensureServingProcess serves and reuses remote Modal processes without local PID checks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "homestead-modal-test-"))
    const registry = new Registry(join(dir, "models.db"))

    try {
      const model = makeModel({
        id: "modal-ensure-test",
        status: "discovered",
        metadata: {
          modalEndpoint: "https://workspace--app.modal.run/v1",
          skipHealthcheck: true,
        },
      })
      registry.upsert(model)

      const result1 = await ensureServingProcess(model, registry)
      expect(result1.error).toBeUndefined()
      expect(result1.proc?.engineKind).toBe("modal")
      expect(result1.proc?.endpoint).toBe("https://workspace--app.modal.run/v1")
      expect(registry.get(model.id)?.status).toBe("serving")

      // Subsequent call reuses the active remote serving process
      const result2 = await ensureServingProcess(model, registry)
      expect(result2.error).toBeUndefined()
      expect(result2.proc).toBe(result1.proc)
    } finally {
      registry.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
