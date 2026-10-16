import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Registry } from "../src/core/registry.js"
import { createProviderApp } from "../src/provider/homestead.js"
import { resolveModelManifest, calculateEntropyConfidence, normalizeDistribution } from "../src/provider/systemone.js"
import { HomesteadProvider, choice, noul } from "../../../packages/s1sdk/src/index.js"
import { serve, type Server } from "bun"

describe("System-1 Provider & /v1/systemone API", () => {
  let tmpDir: string
  let registry: Registry
  let app: ReturnType<typeof createProviderApp>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "homestead-s1-test-"))
    registry = new Registry(join(tmpDir, "models.db"))
    app = createProviderApp(registry)
  })

  afterEach(() => {
    registry.close()
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  // ==========================================================================
  // Health & Information Endpoints
  // ==========================================================================

  describe("Health & Discovery Endpoints", () => {
    it("GET /health responds with { status: 'ok' }", async () => {
      const res = await app.fetch(new Request("http://localhost/health"))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.status).toBe("ok")
      expect(typeof data.version).toBe("string")
      expect(typeof data.models_available).toBe("number")
    })

    it("GET /v1/health responds with { status: 'ok' } for s1sdk compatibility", async () => {
      const res = await app.fetch(new Request("http://localhost/v1/health"))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.status).toBe("ok")
      expect(typeof data.version).toBe("string")
    })

    it("GET /v1/systemone returns daemon info", async () => {
      const res = await app.fetch(new Request("http://localhost/v1/systemone"))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.status).toBe("ok")
      expect(data.daemon).toBe("homestead-system-one")
    })
  })

  // ==========================================================================
  // Request Validation
  // ==========================================================================

  describe("Request Validation", () => {
    it("rejects request without model", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/systemone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: "hello", questions: { q: { type: "noul" } } }),
        })
      )
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error.code).toBe("missing_model")
    })

    it("rejects request without state", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/systemone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "homerouter-420M", questions: { q: { type: "noul" } } }),
        })
      )
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error.code).toBe("missing_state")
    })

    it("rejects request without questions", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/systemone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "homerouter-420M", state: "hello" }),
        })
      )
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error.code).toBe("missing_questions")
    })

    it("rejects empty questions object", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/systemone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "homerouter-420M", state: "hello", questions: {} }),
        })
      )
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error.code).toBe("empty_questions")
    })

    it("rejects question with unsupported type", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/systemone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "homerouter-420M",
            state: "hello",
            questions: { q1: { type: "unsupported_type" } },
          }),
        })
      )
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error.code).toBe("unsupported_question_type")
    })
  })

  // ==========================================================================
  // Model Manifest Resolution
  // ==========================================================================

  describe("Model Manifest Resolution", () => {
    it("resolves manifest for homerouter-420M", () => {
      const manifest = resolveModelManifest("homerouter-420M", registry)
      expect(manifest.architecture).toBe("SmallDecisionModel")
      expect(manifest.base_architecture).toBe("ModernBERT-large")
      expect(manifest.num_parameters).toBe(421000000)
      expect(manifest.calibration).toBeDefined()
      expect(manifest.calibration?.recommended_threshold).toBe(0.9)
    })

    it("resolves manifest for s1/homerouter-agentic-420m with 10 tools", () => {
      const manifest = resolveModelManifest("s1/homerouter-agentic-420m", registry)
      expect(manifest.options).toContain("read")
      expect(manifest.options).toContain("bash")
      expect(manifest.options).toContain("grep_search")
      expect(manifest.options).toContain("tier_frontier")
      expect(manifest.calibration?.temperature).toBeGreaterThan(0)
    })

    it("resolves manifest for s1/homerouter-service-420m with 30 options", () => {
      const manifest = resolveModelManifest("s1/homerouter-service-420m", registry)
      expect(manifest.options?.length).toBeGreaterThanOrEqual(25)
      expect(manifest.options).toContain("offer-refund")
    })
  })

  // ==========================================================================
  // Mathematical Invariants: Strict 1.0000 Sum & Entropy
  // ==========================================================================

  describe("Mathematical Invariants", () => {
    it("guarantees probabilities sum strictly to 1.0000", () => {
      const rawScores = {
        optA: 4.12,
        optB: 1.55,
        optC: 0.12,
        optD: 2.89,
        optE: 3.44,
      }
      const norm = normalizeDistribution(rawScores, 0.9384)
      const sum = Object.values(norm.probabilities).reduce((a, b) => a + b, 0)
      expect(sum).toBe(1.0)
      expect(norm.topChoice).toBe("optA")
      expect(norm.probabilities["optA"]).toBeGreaterThan(norm.probabilities["optB"])
    })

    it("computes normalized Shannon entropy confidence", () => {
      const uniform = { a: 0.25, b: 0.25, c: 0.25, d: 0.25 }
      const confUniform = calculateEntropyConfidence(uniform)
      expect(confUniform).toBeCloseTo(0.0, 3)

      const concentrated = { a: 0.97, b: 0.01, c: 0.01, d: 0.01 }
      const confConcentrated = calculateEntropyConfidence(concentrated)
      expect(confConcentrated).toBeGreaterThan(0.75)
    })
  })

  // ==========================================================================
  // Developer Agent Tool Routing & Escalation (05-homerouter example)
  // ==========================================================================

  describe("Developer Agent Tool Routing", () => {
    const devQuestions = {
      action: {
        type: "choice" as const,
        instructions: "Select next action or tier escalation",
        criteria: {
          read: "Inspect local file contents",
          view_file: "Inspect workspace project file",
          edit_file: "Modify or patch source file",
          write: "Create new file on filesystem",
          bash: "Execute shell commands or test suites",
          run_command: "Execute workspace tools",
          grep_search: "Search regex patterns across files",
          tier_frontier: "Escalate to frontier reasoning model (Claude 3.5 Sonnet / DeepSeek R1)",
        },
      },
    }

    it("routes grep query to grep_search with >=90% confidence", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/systemone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "homerouter-420M-v1.1",
            state: 'grep for "ECONNREFUSED" in server.log and find where it is thrown',
            questions: devQuestions,
          }),
        })
      )

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.provider).toBe("homestead")
      expect(data.model).toBe("homerouter-420M-v1.1")
      expect(data.answers.action.choice).toBe("grep_search")
      expect(data.answers.action.confidence).toBeGreaterThanOrEqual(0.9)

      // Strict sum verification
      const sum = Object.values(data.answers.action.probabilities as Record<string, number>).reduce(
        (a, b) => a + b,
        0
      )
      expect(sum).toBe(1.0)

      // Telemetry verification
      expect(data.latency_ms).toBeLessThan(5.0)
      expect(data.usage.output_tokens).toBe(0)
      expect(data.usage.input_tokens).toBeGreaterThan(0)
    })

    it("routes cat query to read", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/systemone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "s1/homerouter-agentic-420m",
            state: "cat packages/s1-train/pyproject.toml and check the dependencies",
            questions: devQuestions,
          }),
        })
      )

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.answers.action.choice).toBe("read")
    })

    it("routes bun test query to bash", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/systemone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "s1/homerouter-agentic-420m",
            state: "run the full test suite with bun test",
            questions: devQuestions,
          }),
        })
      )

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.answers.action.choice).toBe("bash")
    })

    it("routes novel distributed architecture query to tier_frontier", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/systemone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "s1/homerouter-agentic-420m",
            state: "architect a completely new distributed consensus protocol for high-frequency trading",
            questions: devQuestions,
          }),
        })
      )

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.answers.action.choice).toBe("tier_frontier")
    })
  })

  // ==========================================================================
  // Healthcare FHIR Tool Dispatch & Safety Gating (05-homerouter example)
  // ==========================================================================

  describe("Healthcare FHIR Tool Dispatch & Safety Gating", () => {
    const clinicalQuestions = {
      fhir_resource: {
        type: "choice" as const,
        instructions: "Route clinical utterance to correct Medplum FHIR builder",
        criteria: {
          Observation: "Vitals, blood pressure, heart rate, lab observations",
          Appointment: "Scheduling, clinic booking, provider encounters",
          MedicationRequest: "Prescriptions, refills, pharmacological orders",
          DiagnosticReport: "Complex diagnostic results, imaging, cardiologist reviews",
        },
      },
      requires_physician_review: {
        type: "noul" as const,
        instructions: "Assess if clinical input has ambiguity or high safety risk",
        criteria: {
          true: "Uncertain or critical clinical finding",
          false: "Routine standardized recording",
        },
      },
    }

    it("classifies routine vitals as Observation with safe auto-commit (risk < 0.20)", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/systemone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "homerouter-420M",
            state: "Patient presents with blood pressure 145/95 mmHg, heart rate 82 bpm, resting.",
            questions: clinicalQuestions,
          }),
        })
      )

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.answers.fhir_resource.choice).toBe("Observation")
      expect(data.answers.requires_physician_review.noul).toBeLessThan(0.2)
      expect(data.answers.requires_physician_review.verdict).toBe(false)
    })

    it("classifies appointment request as Appointment", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/systemone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "homerouter-420M",
            state: "Schedule follow-up cardiology visit with Dr. Sarah Chen next Tuesday at 2 PM.",
            questions: clinicalQuestions,
          }),
        })
      )

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.answers.fhir_resource.choice).toBe("Appointment")
    })

    it("classifies prescription order as MedicationRequest", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/systemone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "homerouter-420M",
            state: "Prescribe Lisinopril 10mg once daily oral tablet for hypertension.",
            questions: clinicalQuestions,
          }),
        })
      )

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.answers.fhir_resource.choice).toBe("MedicationRequest")
    })

    it("flags ambiguous palpitations as DiagnosticReport held for physician review (risk > 0.80)", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/systemone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "homerouter-420M",
            state: "Patient complains of vague chest fluttering, possibly benign palpitations or early arrhythmia.",
            questions: clinicalQuestions,
          }),
        })
      )

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.answers.fhir_resource.choice).toBe("DiagnosticReport")
      expect(data.answers.requires_physician_review.noul).toBeGreaterThan(0.8)
      expect(data.answers.requires_physician_review.verdict).toBe(true)
    })
  })

  // ==========================================================================
  // Score Questions
  // ==========================================================================

  describe("Score Questions", () => {
    it("evaluates ordinal score with probability distribution and expected score", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/systemone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "homerouter-420M",
            state: "System degradation detected on cache nodes with rising error rates",
            questions: {
              severity: {
                type: "score",
                instructions: "Assess incident severity on 1-5 scale",
                levels: [1, 2, 3, 4, 5],
              },
            },
          }),
        })
      )

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.answers.severity.type).toBe("score")
      expect(typeof data.answers.severity.score).toBe("number")
      expect(typeof data.answers.severity.expected_score).toBe("number")
      expect(typeof data.answers.severity.confidence).toBe("number")

      const sum = Object.values(data.answers.severity.probabilities as Record<string, number>).reduce(
        (a, b) => a + b,
        0
      )
      expect(sum).toBe(1.0)
    })
  })

  // ==========================================================================
  // Array Questions Format Normalization
  // ==========================================================================

  describe("Array Questions Normalization", () => {
    it("handles legacy array questions format", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/systemone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "homerouter-420M",
            state: "cat server.log",
            questions: [
              {
                id: "tool",
                type: "choice",
                instructions: "Pick tool",
                criteria: { read: "read file", bash: "run bash" },
              },
            ],
          }),
        })
      )

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.answers.tool).toBeDefined()
      expect(data.answers.tool.choice).toBe("read")
    })
  })

  // ==========================================================================
  // Direct Root Mount (/systemone)
  // ==========================================================================

  describe("Direct Root Mount /systemone", () => {
    it("POST /systemone executes identically to /v1/systemone", async () => {
      const res = await app.fetch(
        new Request("http://localhost/systemone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "homerouter-420M",
            state: "cat server.log",
            questions: {
              tool: {
                type: "choice",
                instructions: "Pick tool",
                criteria: { read: "read file", bash: "run bash" },
              },
            },
          }),
        })
      )

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.provider).toBe("homestead")
      expect(data.answers.tool.choice).toBe("read")
    })
  })

  // ==========================================================================
  // s1sdk Client Integration
  // ==========================================================================

  describe("s1sdk HomesteadProvider End-to-End Integration", () => {
    let testServer: Server<any>
    let testPort: number

    beforeEach(() => {
      testPort = 19876
      testServer = serve({
        fetch: app.fetch,
        port: testPort,
      })
    })

    afterEach(() => {
      testServer.stop(true)
    })

    it("s1sdk HomesteadProvider.isHealthy() succeeds against running daemon", async () => {
      const provider = new HomesteadProvider({
        endpoint: `http://127.0.0.1:${testPort}/v1/systemone`,
      })
      const isHealthy = await provider.isHealthy()
      expect(isHealthy).toBe(true)
    })

    it("s1sdk HomesteadProvider.decide() executes single forward pass decision with sub-5ms latency", async () => {
      const provider = new HomesteadProvider({
        endpoint: `http://127.0.0.1:${testPort}/v1/systemone`,
        model: "homerouter-420M-v1.1",
      })

      const decision = await provider.decide({
        state: 'grep for "ECONNREFUSED" in server.log and find where it is thrown',
        questions: {
          action: choice("Select next action or tier escalation", {
            read: "Inspect local file contents",
            view_file: "Inspect workspace project file",
            edit_file: "Modify or patch source file",
            write: "Create new file on filesystem",
            bash: "Execute shell commands or test suites",
            run_command: "Execute workspace tools",
            grep_search: "Search regex patterns across files",
            tier_frontier: "Escalate to frontier reasoning model (Claude 3.5 Sonnet / DeepSeek R1)",
          }),
          requires_escalation: noul("Does query require frontier model escalation?"),
        },
      })

      expect(decision.providerUsed).toBe("homestead")
      expect(decision.modelUsed).toBe("homerouter-420M-v1.1")
      expect(decision.answers.action.choice).toBe("grep_search")
      expect(decision.answers.action.confidence).toBeGreaterThanOrEqual(0.9)
      expect(decision.answers.requires_escalation.noul).toBeLessThan(0.3)
      expect(decision.latencyMs).toBeLessThan(15.0) // E2E HTTP roundtrip within test process
      expect(decision.usage?.outputTokens).toBe(0)
    })
  })
})
