import { describe, it, expect } from "bun:test"
import { Registry } from "../src/core/registry.js"
import { createProviderApp } from "../src/provider/homestead.js"
import { HomesteadS1Client, choice, score, noul, defineSchema } from "../src/sdk/s1-client.js"

describe("S1 System-1 Wire Protocol Smoke Test", () => {
  const registry = new Registry()
  const app = createProviderApp(registry)

  const client = new HomesteadS1Client({
    baseUrl: "http://127.0.0.1:18765",
    fetch: ((url: string, init: any) => {
      const path = new URL(url).pathname
      return app.request(path, init)
    }) as typeof fetch,
  })

  it("evaluates a complex multi-question S1 schema end-to-end", async () => {
    const questions = [
      choice("threat_level", "Classify network anomaly threat level", [
        "LOW",
        "ELEVATED",
        "HIGH",
        "CRITICAL",
      ]),
      score("confidence_score", "Confidence in intrusion detection from 1 to 10", 1, 10),
      noul("immediate_block_required", "Should IP be placed on immediate firewall blocklist?"),
    ]

    const schema = defineSchema("sec-ops-v1", questions, {
      name: "Security Operations Anomaly Assessment",
    })

    const response = await client.systemOne({
      state: "Alert: Repeated SSH brute force attempts detected from IP 198.51.100.42. 45 failed logins in 60s.",
      questions: schema.questions,
    })

    expect(response.id).toMatch(/^s1-/)
    expect(response.usage.total_tokens).toBeGreaterThan(0)
    expect(response.usage.latency_ms).toBeGreaterThanOrEqual(0)

    // Verify Choice Answer
    const threatAns = response.answers["threat_level"]
    expect(threatAns.type).toBe("choice")
    if (threatAns.type === "choice") {
      expect(["LOW", "ELEVATED", "HIGH", "CRITICAL"]).toContain(threatAns.value)
      expect(threatAns.confidence).toBeGreaterThan(0)
      expect(Object.keys(threatAns.probabilities).length).toBe(4)
    }

    // Verify Score Answer
    const confAns = response.answers["confidence_score"]
    expect(confAns.type).toBe("score")
    if (confAns.type === "score") {
      expect(confAns.expected_score).toBeGreaterThanOrEqual(1)
      expect(confAns.expected_score).toBeLessThanOrEqual(10)
      expect(confAns.bounds?.min).toBe(1)
      expect(confAns.bounds?.max).toBe(10)
    }

    // Verify Noul Answer
    const blockAns = response.answers["immediate_block_required"]
    expect(blockAns.type).toBe("noul")
    if (blockAns.type === "noul") {
      expect(typeof blockAns.value).toBe("boolean")
      expect(blockAns.probability).toBeGreaterThanOrEqual(0)
      expect(blockAns.probability).toBeLessThanOrEqual(1)
      expect(typeof blockAns.log_odds).toBe("number")
    }
  })

  it("handles /decide endpoint with low-latency binary verdict", async () => {
    const result = await client.decide(
      "Git commit SHA verification matches signed GPG key.",
      "Is commit signature valid and trusted?"
    )

    expect(typeof result.decision).toBe("boolean")
    expect(result.confidence).toBeGreaterThanOrEqual(0.5)
    expect(result.latency_ms).toBeGreaterThanOrEqual(0)
  })

  it("handles /score endpoint with expected score computation", async () => {
    const result = await client.score(
      "Model inference benchmark: 142 tokens/sec, TTFT 28ms, zero memory leaks across 10k requests.",
      "Score inference performance rating",
      { min: 1, max: 10 }
    )

    expect(result.expected_score).toBeGreaterThanOrEqual(1)
    expect(result.expected_score).toBeLessThanOrEqual(10)
    expect(Object.keys(result.distribution).length).toBe(10)
  })
})
