import { describe, it, expect, beforeEach } from "bun:test"
import {
  softmax,
  calculateExpectedScore,
  calculateLogOdds,
  calculateBinaryConfidence,
  type ChoiceQuestion,
  type ScoreQuestion,
  type NoulQuestion,
  type SystemOneRequest,
} from "../../src/s1/types.js"
import { SchemaCache, globalSchemaCache } from "../../src/s1/schema-cache.js"
import { ArLogitAdapter } from "../../src/s1/adapters/ar-logit.js"
import { DeciderAdapter } from "../../src/s1/adapters/decider.js"
import { LayaAdapter } from "../../src/s1/adapters/laya.js"
import { NanoJevAdapter } from "../../src/s1/adapters/nanojev.js"
import { S1EngineRouter } from "../../src/s1/adapters/router.js"
import { Registry } from "../../src/core/registry.js"
import { createProviderApp } from "../../src/provider/homestead.js"
import {
  HomesteadS1Client,
  choice,
  score,
  noul,
  defineSchema,
} from "../../src/sdk/s1-client.js"
import type { ModelRecord } from "../../src/types.js"

describe("S1 Mathematical Helpers", () => {
  it("computes numerically stable softmax", () => {
    const logits = [2.0, 1.0, 0.1]
    const probs = softmax(logits)

    expect(probs.length).toBe(3)
    const sum = probs.reduce((a, b) => a + b, 0)
    expect(Math.abs(sum - 1.0)).toBeLessThan(1e-5)
    expect(probs[0]).toBeGreaterThan(probs[1])
    expect(probs[1]).toBeGreaterThan(probs[2])
  })

  it("handles empty logits and extreme values in softmax", () => {
    expect(softmax([])).toEqual([])
    const extreme = softmax([1000, 1000, 1000])
    expect(extreme.length).toBe(3)
    expect(extreme[0]).toBeCloseTo(1 / 3, 4)
  })

  it("computes continuous expected score E[S]", () => {
    const dist = { 1: 0.1, 2: 0.2, 3: 0.4, 4: 0.2, 5: 0.1 }
    const expected = calculateExpectedScore(dist)
    // 1*0.1 + 2*0.2 + 3*0.4 + 4*0.2 + 5*0.1 = 0.1 + 0.4 + 1.2 + 0.8 + 0.5 = 3.0
    expect(expected).toBeCloseTo(3.0, 5)
  })

  it("computes calibrated log-odds and binary confidence", () => {
    const p = 0.8
    const logOdds = calculateLogOdds(p)
    expect(logOdds).toBeGreaterThan(0)
    expect(calculateBinaryConfidence(p)).toBe(0.8)
    expect(calculateBinaryConfidence(0.2)).toBe(0.8)
  })
})

describe("S1 Schema & Prefix Caching", () => {
  let cache: SchemaCache

  beforeEach(() => {
    cache = new SchemaCache({ maxSchemas: 5, maxPrefixes: 5, ttlMs: 10_000 })
  })

  it("generates deterministic SHA-256 hashes for schemas", () => {
    const questions: ChoiceQuestion[] = [
      { id: "q1", type: "choice", prompt: "Pick one", options: ["A", "B", "C"] },
    ]
    const hash1 = cache.computeHash(questions)
    const hash2 = cache.computeHash(questions)
    expect(hash1).toBe(hash2)
    expect(hash1.length).toBe(64)
  })

  it("compiles and registers schemas with slot keys", () => {
    const q1: ChoiceQuestion = { id: "action", type: "choice", prompt: "Next action", options: ["read", "write"] }
    const q2: ScoreQuestion = { id: "quality", type: "score", prompt: "Rate quality", min: 1, max: 5 }
    const compiled = cache.compile([q1, q2], "test-schema", "Test Schema")

    expect(compiled.id).toBe("test-schema")
    expect(compiled.slotKeys).toEqual(["action", "quality"])
    expect(compiled.compiledPromptPrefix).toContain("[SCHEMA]")
    expect(compiled.compiledPromptPrefix).toContain("Next action")

    const retrieved = cache.get("test-schema")
    expect(retrieved?.hash).toBe(compiled.hash)
  })

  it("manages prefix cache with hit/miss tracking and eviction", () => {
    cache.setPrefix("prefix-1", "schema-1", "prefix-content-1")
    const p1 = cache.getPrefix("prefix-1")
    expect(p1?.prefixText).toBe("prefix-content-1")

    const missing = cache.getPrefix("missing-key")
    expect(missing).toBeUndefined()

    const stats = cache.getStats()
    expect(stats.hits).toBe(1)
    expect(stats.misses).toBe(1)
    expect(stats.prefixCount).toBe(1)
  })
})

describe("S1 Architecture Adapters", () => {
  const sampleChoice: ChoiceQuestion = {
    id: "route",
    type: "choice",
    prompt: "Choose the target microservice",
    options: ["auth-service", "billing-service", "analytics-service"],
  }

  const sampleScore: ScoreQuestion = {
    id: "safety",
    type: "score",
    prompt: "Rate safety tier from 1 to 5",
    min: 1,
    max: 5,
  }

  const sampleNoul: NoulQuestion = {
    id: "is_valid",
    type: "noul",
    prompt: "Does the input meet compliance requirements?",
  }

  it("ArLogitAdapter evaluates Choice, Score, and Noul questions", async () => {
    const adapter = new ArLogitAdapter()
    const req: SystemOneRequest = {
      state: "User requesting authorization for billing transaction. Compliance check passed successfully.",
      questions: [sampleChoice, sampleScore, sampleNoul],
    }

    const res = await adapter.evaluate(req)
    expect(res.adapter).toBe("ar-logit")
    expect(res.answers["route"].type).toBe("choice")
    expect(res.answers["safety"].type).toBe("score")
    expect(res.answers["is_valid"].type).toBe("noul")

    const choiceAns = res.answers["route"] as any
    expect(choiceAns.confidence).toBeGreaterThan(0)
    expect(choiceAns.probabilities).toBeDefined()

    const scoreAns = res.answers["safety"] as any
    expect(scoreAns.expected_score).toBeGreaterThanOrEqual(1)
    expect(scoreAns.expected_score).toBeLessThanOrEqual(5)

    const noulAns = res.answers["is_valid"] as any
    expect(typeof noulAns.value).toBe("boolean")
    expect(noulAns.probability).toBeGreaterThanOrEqual(0)
    expect(noulAns.probability).toBeLessThanOrEqual(1)
  })

  it("DeciderAdapter handles slot-head layout and parallel evaluation", async () => {
    const adapter = new DeciderAdapter()
    const req: SystemOneRequest = {
      state: "Operation completed with warnings.",
      questions: [sampleChoice, sampleScore],
      layout: "state-first",
    }

    const res = await adapter.evaluate(req)
    expect(res.adapter).toBe("decider")
    expect(res.usage.completion_tokens).toBe(2)
    expect(res.answers["route"]).toBeDefined()
    expect(res.answers["safety"]).toBeDefined()
  })

  it("LayaAdapter performs non-autoregressive encoder evaluation", async () => {
    const adapter = new LayaAdapter()
    const req: SystemOneRequest = {
      state: "System health check reports all systems operational.",
      questions: [sampleNoul, sampleScore],
    }

    const res = await adapter.evaluate(req)
    expect(res.adapter).toBe("laya")
    expect(res.usage.completion_tokens).toBe(0) // Non-autoregressive
    expect(res.answers["is_valid"]).toBeDefined()
  })

  it("NanoJevAdapter formats set attention heads and evaluates questions", async () => {
    const adapter = new NanoJevAdapter()
    const req: SystemOneRequest = {
      state: "Resource allocation optimal.",
      questions: [sampleChoice, sampleNoul],
    }

    const res = await adapter.evaluate(req)
    expect(res.adapter).toBe("nanojev")
    expect(res.answers["route"]).toBeDefined()
    expect(res.answers["is_valid"]).toBeDefined()
  })

  it("S1EngineRouter selects optimal adapter based on model record metadata", () => {
    const router = new S1EngineRouter()

    const deciderModel: ModelRecord = {
      id: "decider-2b-v1",
      name: "decider-2b",
      source: "hf-hub",
      sourceId: "decider-2b",
      path: "/models/decider-2b.gguf",
      sizeBytes: 2000000000,
      format: "gguf",
      quantization: "Q4_K_M",
      engine: "llama.cpp",
      status: "discovered",
      metadata: { architecture: "decider" },
      discoveredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const layaModel: ModelRecord = {
      ...deciderModel,
      id: "modernbert-laya",
      name: "modernbert-laya",
      metadata: { architecture: "laya" },
    }

    const nanojevModel: ModelRecord = {
      ...deciderModel,
      id: "qwen-0.6b-s1",
      name: "qwen-0.6b-s1",
      metadata: { architecture: "nanojev" },
    }

    const standardModel: ModelRecord = {
      ...deciderModel,
      id: "llama-3-8b",
      name: "llama-3-8b",
      metadata: {},
    }

    expect(router.selectAdapter({ state: "test" }, deciderModel).name).toBe("decider")
    expect(router.selectAdapter({ state: "test" }, layaModel).name).toBe("laya")
    expect(router.selectAdapter({ state: "test" }, nanojevModel).name).toBe("nanojev")
    expect(router.selectAdapter({ state: "test" }, standardModel).name).toBe("ar-logit")

    // Explicit override in request takes precedence
    expect(router.selectAdapter({ state: "test", adapter: "laya" }, deciderModel).name).toBe("laya")
  })
})

describe("S1 Provider HTTP Endpoints & Client SDK Integration", () => {
  const registry = new Registry()
  const app = createProviderApp(registry)

  it("POST /v1/systemone processes full SystemOneRequest", async () => {
    const payload: SystemOneRequest = {
      state: "Payment gateway response code: 200 OK. Transaction verified.",
      questions: [
        {
          id: "outcome",
          type: "choice",
          prompt: "Determine transaction outcome",
          options: ["SUCCESS", "FAILED", "PENDING"],
        },
        {
          id: "is_fraud",
          type: "noul",
          prompt: "Is this transaction fraudulent?",
        },
      ],
    }

    const res = await app.request("/v1/systemone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })

    expect(res.status).toBe(200)
    const data = (await res.json()) as any
    expect(data.answers.outcome).toBeDefined()
    expect(data.answers.outcome.type).toBe("choice")
    expect(data.answers.is_fraud).toBeDefined()
    expect(data.answers.is_fraud.type).toBe("noul")
  })

  it("POST /decide returns convenience decision payload", async () => {
    const res = await app.request("/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: "Database query latency is 450ms, threshold is 200ms.",
        question: "Select database alert level",
        options: ["NORMAL", "WARNING", "CRITICAL"],
      }),
    })

    expect(res.status).toBe(200)
    const data = (await res.json()) as any
    expect(data.decision).toBeDefined()
    expect(data.confidence).toBeGreaterThan(0)
    expect(data.probabilities).toBeDefined()
  })

  it("POST /score returns convenience score payload", async () => {
    const res = await app.request("/score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: "Code review: clean architecture, 100% test coverage, comprehensive documentation.",
        question: "Rate PR code quality",
        min: 1,
        max: 5,
      }),
    })

    expect(res.status).toBe(200)
    const data = (await res.json()) as any
    expect(data.expected_score).toBeGreaterThanOrEqual(1)
    expect(data.expected_score).toBeLessThanOrEqual(5)
    expect(data.distribution).toBeDefined()
  })

  it("HomesteadS1Client SDK interacts seamlessly with provider app", async () => {
    // Instantiate SDK targeting provider app via custom fetch
    const client = new HomesteadS1Client({
      baseUrl: "http://localhost:18765",
      fetch: ((url: string, init: any) => {
        const path = new URL(url).pathname
        return app.request(path, init)
      }) as typeof fetch,
    })

    const q1 = choice("action", "Select next step", ["DEPLOY", "ROLLBACK"])
    const q2 = score("readiness", "Assess deployment readiness", 1, 10)
    const q3 = noul("gate_passed", "Did all smoke tests pass?")

    const s1Res = await client.systemOne({
      state: "All integration tests passed. Staging deployment green.",
      questions: [q1, q2, q3],
    })

    expect(s1Res.answers["action"].value).toBeDefined()
    expect(s1Res.answers["readiness"].type).toBe("score")
    expect(s1Res.answers["gate_passed"].type).toBe("noul")

    const decideRes = await client.decide(
      "Service load at 90%",
      "Should we scale up?",
      ["SCALE_UP", "MAINTAIN", "SCALE_DOWN"]
    )
    expect(decideRes.decision).toBeDefined()

    const scoreRes = await client.score("System uptime 99.99%", "Rate availability", { min: 1, max: 5 })
    expect(scoreRes.expected_score).toBeGreaterThan(0)
  })
})
