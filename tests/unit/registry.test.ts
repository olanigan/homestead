import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Registry } from "../../src/core/registry.js"
import type { ModelRecord } from "../../src/types.js"

function makeModel(overrides: Partial<ModelRecord> = {}): ModelRecord {
  const now = new Date().toISOString()
  return {
    id: "test-1",
    name: "Test Model",
    source: "imported",
    sourceId: "source-1",
    path: "/tmp/model.gguf",
    sizeBytes: 1024,
    format: "gguf",
    quantization: "Q4_K_M",
    engine: "llama.cpp",
    status: "discovered",
    metadata: { tags: ["weights"] },
    discoveredAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe("Registry", () => {
  let dir: string
  let registry: Registry

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "homestead-registry-"))
    registry = new Registry(join(dir, "models.db"))
  })

  afterAll(() => {
    registry.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("upsert inserts a new model", () => {
    registry.upsert(makeModel())
    const found = registry.get("test-1")
    expect(found).not.toBeNull()
    expect(found?.name).toBe("Test Model")
  })

  test("upsert updates an existing model by source id", () => {
    registry.upsert(makeModel({ sizeBytes: 4096 }))
    const found = registry.get("test-1")
    expect(found?.sizeBytes).toBe(4096)
    expect(registry.list().length).toBe(1)
  })

  test("get resolves by name as well as id", () => {
    const byName = registry.get("Test Model")
    expect(byName?.id).toBe("test-1")
  })

  test("updateStatus transitions model status", () => {
    registry.updateStatus("test-1", "serving")
    expect(registry.get("test-1")?.status).toBe("serving")
  })

  test("stats aggregates correctly", () => {
    registry.upsert(makeModel({ id: "test-2", sourceId: "source-2", name: "Second", status: "discovered" }))
    const stats = registry.stats()
    expect(stats.totalModels).toBe(2)
    expect(stats.servingCount).toBe(1)
    expect(stats.byStatus.serving).toBe(1)
  })

  test("deleteBySource removes only that source", () => {
    registry.deleteBySource("imported")
    expect(registry.list().length).toBe(0)
  })

  test("dedupCrossSource keeps preferred source", () => {
    const shared = "shared-source-id"
    registry.upsert(makeModel({ id: "mlx-one", source: "mlx", sourceId: shared, format: "mlx" }))
    registry.upsert(makeModel({ id: "hf-one", source: "hf-hub", sourceId: shared }))
    const removed = registry.dedupCrossSource("mlx", "hf-hub")
    expect(removed).toBe(1)
    expect(registry.get("mlx-one")).not.toBeNull()
    expect(registry.get("hf-one")).toBeNull()
  })
})
