import { describe, test, expect } from "bun:test"
import { RemoteOpenAIAdapter } from "../../src/engines/remote.js"
import { engineManager } from "../../src/engines/index.js"
import type { ModelRecord } from "../../src/types.js"

function makeModel(overrides: Partial<ModelRecord> = {}): ModelRecord {
  const now = new Date().toISOString()
  return {
    id: "deepseek-chat",
    name: "deepseek-chat",
    source: "deepseek",
    sourceId: "https://api.deepseek.com/v1",
    path: "https://api.deepseek.com/v1",
    sizeBytes: 0,
    format: "safetensors",
    quantization: null,
    engine: "remote",
    status: "discovered",
    metadata: {
      tags: ["weights", "cloud"],
      provider: "deepseek",
      remoteEndpoint: "https://api.deepseek.com/v1",
    },
    discoveredAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe("RemoteOpenAIAdapter", () => {
  const adapter = new RemoteOpenAIAdapter()

  test("canHandle recognizes deepseek, openrouter, and remote models", () => {
    expect(adapter.canHandle(makeModel())).toBe(true)
    expect(adapter.canHandle(makeModel({ engine: "remote", path: "/tmp/model" }))).toBe(true)
    expect(adapter.canHandle(makeModel({ source: "openrouter", path: "openrouter://model" }))).toBe(true)
    expect(adapter.canHandle(makeModel({ metadata: { provider: "openrouter" }, path: "/tmp/model" }))).toBe(true)
    expect(adapter.canHandle(makeModel({ metadata: { remoteEndpoint: "https://my-api.com/v1" }, path: "/tmp/model" }))).toBe(true)
    expect(adapter.canHandle(makeModel({ engine: "llama.cpp", source: "gguf-file", path: "/tmp/model.gguf", metadata: {} }))).toBe(false)
  })

  test("resolveEndpoint normalizes endpoints with /v1 and https", () => {
    expect(adapter.resolveEndpoint(makeModel({ metadata: { remoteEndpoint: "https://api.deepseek.com" } }))).toBe("https://api.deepseek.com/v1")
    expect(adapter.resolveEndpoint(makeModel({ metadata: { remoteEndpoint: "http://localhost:8000/v1/" } }))).toBe("http://localhost:8000/v1")
    expect(adapter.resolveEndpoint(makeModel({ source: "openrouter", path: "openrouter://model", metadata: {} }))).toBe("https://openrouter.ai/api/v1")
  })

  test("serve and stop lifecycle creates and cleans up serving processes", async () => {
    const model = makeModel({ id: "test-remote-1" })
    const proc = await adapter.serve(model)
    expect(proc.modelId).toBe("test-remote-1")
    expect(proc.engineKind).toBe("remote")
    expect(proc.endpoint).toBe("https://api.deepseek.com/v1")

    // Subsequent serve reuses process
    const reused = await adapter.serve(model)
    expect(reused).toBe(proc)

    // Stop process
    await adapter.stop(proc)
  })

  test("EngineManager selects RemoteOpenAIAdapter for remote models", () => {
    const model = makeModel()
    const selected = engineManager.selectEngine(model)
    expect(selected).not.toBeNull()
    expect(selected?.kind).toBe("remote")
  })
})
