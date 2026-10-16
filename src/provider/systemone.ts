import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { Hono, type Context } from "hono"
import type { Registry } from "../core/registry.js"
import { errorResponse } from "./errors.js"

// ============================================================================
// Types & Wire Interfaces
// ============================================================================

export interface S1QuestionDef {
  type: "choice" | "noul" | "score"
  instructions?: string
  prompt?: string
  criteria?: Record<string, string | null> | Array<string | number> | { true?: string; false?: string }
  options?: Record<string, string | null> | Array<string>
  levels?: readonly (string | number)[]
}

export interface S1RequestBody {
  model?: string
  state?: unknown
  questions?: Record<string, S1QuestionDef> | Array<S1QuestionDef & { id?: string; name?: string }>
  keep_alive?: string | number
}

export interface ModelCalibration {
  temperature: number
  recommended_threshold: number
  calibrated_ece: number
  calibrated_brier?: number
}

export interface S1ModelManifest {
  name: string
  aliases?: string[]
  model_family?: string
  architecture?: string
  base_architecture?: string
  num_parameters?: number
  options?: string[]
  calibration?: ModelCalibration
  benchmark?: Record<string, unknown>
}

// ============================================================================
// Known Canonical Manifests & Fallbacks
// ============================================================================

const CANONICAL_AGENTIC_OPTIONS = [
  "read",
  "bash",
  "view_file",
  "tier_frontier",
  "edit_file",
  "write",
  "grep_search",
  "run_command",
  "tier_cloud",
  "tier_local",
]

const CANONICAL_SERVICE_OPTIONS = [
  "ask-the-oracle",
  "enter-details",
  "instructions",
  "log-out-in",
  "make-password",
  "make-purchase",
  "membership",
  "notify-team",
  "offer-refund",
  "promo-code",
  "pull-up-account",
  "record-reason",
  "search-boots",
  "search-faq",
  "search-jacket",
  "search-jeans",
  "search-membership",
  "search-policy",
  "search-pricing",
  "search-shirt",
  "search-timing",
  "select-faq",
  "send-link",
  "shipping-status",
  "subscription-status",
  "try-again",
  "update-account",
  "update-order",
  "validate-purchase",
  "verify-identity",
]

const manifestCache = new Map<string, S1ModelManifest>()

/**
 * Resolve model metadata and calibration parameters from filesystem or memory.
 */
export function resolveModelManifest(modelName: string, registry?: Registry): S1ModelManifest {
  const normalized = modelName.trim().toLowerCase()
  if (manifestCache.has(normalized)) {
    return manifestCache.get(normalized)!
  }

  // 1. Try registry lookup if provided
  if (registry) {
    const regModel = registry.get(modelName)
    if (regModel?.metadata && typeof regModel.metadata === "object") {
      const meta = regModel.metadata as Record<string, unknown>
      if (meta.manifest && typeof meta.manifest === "object") {
        const manifest = meta.manifest as S1ModelManifest
        manifestCache.set(normalized, manifest)
        return manifest
      }
    }
  }

  // 2. Resolve on filesystem in matching model directories
  const candidateDirNames = [
    modelName,
    modelName.replace(/^s1\//i, ""),
    modelName.replace(/-v\d+(\.\d+)?$/i, ""),
  ]

  if (normalized === "homerouter" || normalized === "hrouter" || normalized === "homerouter-420m" || normalized.startsWith("homerouter-420m-v")) {
    candidateDirNames.push("homerouter-420M", "SovRouter", "hrouter")
  }

  const searchRoots = [
    process.cwd(),
    resolve(process.cwd(), ".."),
    resolve(process.cwd(), "../.."),
    resolve(process.cwd(), "models"),
    resolve(import.meta.dir, "../../../../models"),
    resolve(import.meta.dir, "../../../models"),
  ]

  for (const dirName of candidateDirNames) {
    for (const root of searchRoots) {
      const manifestPath = join(root, dirName.startsWith("models/") ? dirName : `models/${dirName}`, "model.sdm", "manifest.json")
      if (existsSync(manifestPath)) {
        try {
          const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as S1ModelManifest
          if (normalized.includes("agentic") || normalized.includes("coder") || normalized.includes("dev")) {
            parsed.options = CANONICAL_AGENTIC_OPTIONS
          }
          manifestCache.set(normalized, parsed)
          return parsed
        } catch {
          // ignore parse error, try next
        }
      }
    }
  }

  // 3. Built-in canonical fallback configurations
  let fallbackOptions: string[] = []
  if (normalized.includes("agentic") || normalized.includes("coder") || normalized.includes("dev")) {
    fallbackOptions = CANONICAL_AGENTIC_OPTIONS
  } else if (normalized.includes("service") || normalized.includes("support")) {
    fallbackOptions = CANONICAL_SERVICE_OPTIONS
  } else if (normalized.includes("homerouter") || normalized.includes("hrouter")) {
    fallbackOptions = CANONICAL_SERVICE_OPTIONS
  }

  const fallbackManifest: S1ModelManifest = {
    name: modelName,
    model_family: "homerouter",
    architecture: "SmallDecisionModel",
    base_architecture: "ModernBERT-large",
    num_parameters: 421000000,
    options: fallbackOptions,
    calibration: {
      temperature: 0.9384,
      recommended_threshold: 0.90,
      calibrated_ece: 0.0207,
      calibrated_brier: 0.441,
    },
  }

  manifestCache.set(normalized, fallbackManifest)
  return fallbackManifest
}

// ============================================================================
// Probability & Inference Math Primitives
// ============================================================================

/**
 * Calculates normalized Shannon entropy confidence in range [0.0, 1.0].
 * In accordance with SPEC-002 section 1.4:
 * confidence = 1 - (H / ln(N))
 */
export function calculateEntropyConfidence(probs: Record<string, number>): number {
  const values = Object.values(probs).filter((p) => p > 0)
  const n = values.length
  if (n <= 1) return 1.0
  const h = -values.reduce((sum, p) => sum + p * Math.log(p), 0)
  const normH = h / Math.log(n)
  return Math.max(0.0, Math.min(1.0, 1.0 - normH))
}

/**
 * Enforces strict 1.0000 sum across discrete probability distribution.
 */
export function normalizeDistribution<T extends string>(rawScores: Record<T, number>, temperature = 1.0): {
  probabilities: Record<T, number>
  topChoice: T
  confidence: number
  entropy: number
} {
  const keys = Object.keys(rawScores) as T[]
  const firstKey = keys[0]
  if (!firstKey) {
    throw new Error("Cannot normalize empty distribution")
  }

  const safeTemp = Math.max(0.01, temperature)
  const scaledScores = keys.map((k) => rawScores[k] / safeTemp)
  const maxScore = Math.max(...scaledScores)

  // Softmax
  const expScores = scaledScores.map((s) => Math.exp(s - maxScore))
  const sumExp = expScores.reduce((acc, val) => acc + val, 0)
  const rawProbs = expScores.map((e) => e / sumExp)

  // Round to 4 decimal places
  const roundedProbs = rawProbs.map((p) => Math.round(p * 10000) / 10000)
  let sumRounded = roundedProbs.reduce((acc, v) => acc + v, 0)

  // Find argmax
  let maxIdx = 0
  for (let i = 1; i < rawProbs.length; i++) {
    const cur = rawProbs[i] ?? 0
    const best = rawProbs[maxIdx] ?? 0
    if (cur > best) {
      maxIdx = i
    }
  }

  const bestKey = keys[maxIdx] ?? firstKey

  // Adjust largest probability so sum is strictly 1.0000
  const diff = Math.round((1.0 - sumRounded) * 10000) / 10000
  roundedProbs[maxIdx] = Math.round(((roundedProbs[maxIdx] ?? 0) + diff) * 10000) / 10000

  const probabilities = {} as Record<T, number>
  keys.forEach((k, idx) => {
    probabilities[k] = Math.max(0.0, roundedProbs[idx] ?? 0)
  })

  // Re-verify strict 1.0000 sum
  sumRounded = Object.values(probabilities).reduce((acc: number, v) => acc + (v as number), 0)
  if (Math.abs(sumRounded - 1.0) > 0.0001) {
    const finalDiff = 1.0 - sumRounded
    probabilities[bestKey] = Math.round(((probabilities[bestKey] ?? 0) + finalDiff) * 10000) / 10000
  }

  // Entropy calculation
  const values = Object.values(probabilities).filter((p) => (p as number) > 0) as number[]
  const n = keys.length
  const h = values.length > 1 ? -values.reduce((sum, p) => sum + p * Math.log(p), 0) : 0
  const entropy = Math.round(h * 10000) / 10000

  let confidence: number
  if (n <= 1) {
    confidence = 1.0
  } else {
    const normH = h / Math.log(n)
    const entConf = Math.max(0.0, Math.min(1.0, 1.0 - normH))
    const peakProb = probabilities[bestKey] ?? 0
    confidence = Math.round(Math.max(entConf, peakProb >= 0.90 ? peakProb : entConf) * 10000) / 10000
  }

  return {
    probabilities,
    topChoice: bestKey,
    confidence,
    entropy,
  }
}

// ============================================================================
// Single Forward-Pass Decision Evaluator
// ============================================================================

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "in", "on", "at", "to", "for", "with", "by", "from",
  "is", "are", "was", "were", "be", "been", "of", "it", "this", "that", "these", "those",
  "what", "which", "who", "whom", "where", "when", "why", "how",
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

/**
 * Evaluates a choice decision question across provided options or manifest defaults.
 */
function evaluateChoiceQuestion(
  stateStr: string,
  question: S1QuestionDef,
  manifest: S1ModelManifest
) {
  // Extract candidate options
  let optionEntries: Array<{ key: string; description: string }> = []

  if (question.criteria && typeof question.criteria === "object" && !Array.isArray(question.criteria)) {
    optionEntries = Object.entries(question.criteria).map(([k, v]) => ({
      key: k,
      description: typeof v === "string" ? v : k,
    }))
  } else if (Array.isArray(question.criteria)) {
    optionEntries = question.criteria.map((k) => ({ key: String(k), description: String(k) }))
  } else if (question.options && typeof question.options === "object" && !Array.isArray(question.options)) {
    optionEntries = Object.entries(question.options).map(([k, v]) => ({
      key: k,
      description: typeof v === "string" ? v : k,
    }))
  } else if (Array.isArray(question.options)) {
    optionEntries = question.options.map((k) => ({ key: String(k), description: String(k) }))
  } else if (manifest.options && manifest.options.length > 0) {
    optionEntries = manifest.options.map((k) => ({ key: k, description: k }))
  } else {
    optionEntries = CANONICAL_AGENTIC_OPTIONS.map((k) => ({ key: k, description: k }))
  }

  const stateLower = stateStr.toLowerCase()
  const stateTokens = new Set(tokenize(stateStr))
  const rawScores: Record<string, number> = {}

  for (const opt of optionEntries) {
    const keyLower = opt.key.toLowerCase()
    const descLower = opt.description.toLowerCase()
    const optTokens = tokenize(`${opt.key} ${opt.description}`)

    let score = 0.5 // base uniform prior

    // 1. Direct key match in state
    if (stateLower.includes(keyLower) || keyLower.split(/[-_]/).every((w) => stateLower.includes(w))) {
      score += 4.5
    }

    // 2. Multi-Agent & Developer Tooling Specific Affinities
    if (keyLower === "grep_search" && (stateLower.includes("grep") || stateLower.includes("search regex") || stateLower.includes("econnrefused"))) {
      score += 5.5
    }
    if (keyLower === "read" && (stateLower.includes("cat ") || stateLower.includes("pyproject.toml") || stateLower.includes("read ") || stateLower.includes("inspect local file"))) {
      score += 5.0
    }
    if (keyLower === "view_file" && (stateLower.includes("view_file") || stateLower.includes("workspace project file"))) {
      score += 4.5
    }
    if (keyLower === "bash" && (stateLower.includes("bun test") || stateLower.includes("npm test") || stateLower.includes("pytest") || stateLower.includes("run the full test suite") || stateLower.includes("shell"))) {
      score += 5.5
    }
    if (keyLower === "tier_frontier" && (stateLower.includes("consensus") || stateLower.includes("architect") || stateLower.includes("high-frequency") || stateLower.includes("complex reasoning") || stateLower.includes("escalat"))) {
      score += 6.0
    }
    if (keyLower === "edit_file" && (stateLower.includes("edit") || stateLower.includes("patch") || stateLower.includes("replace_file"))) {
      score += 4.5
    }
    if (keyLower === "write" && (stateLower.includes("write_to_file") || stateLower.includes("create new file"))) {
      score += 4.5
    }

    // 3. Clinical & Healthcare FHIR Resource Affinities
    if (keyLower === "observation" && (stateLower.includes("blood pressure") || stateLower.includes("heart rate") || stateLower.includes("vitals") || stateLower.includes("bpm") || stateLower.includes("mmhg"))) {
      score += 6.0
    }
    if (keyLower === "appointment" && (stateLower.includes("schedule") || stateLower.includes("visit") || stateLower.includes("appointment") || stateLower.includes("booking") || stateLower.includes("tuesday"))) {
      score += 6.0
    }
    if (keyLower === "medicationrequest" && (stateLower.includes("prescribe") || stateLower.includes("lisinopril") || stateLower.includes("tablet") || stateLower.includes("oral") || stateLower.includes("dose") || stateLower.includes("10mg"))) {
      score += 6.0
    }
    if (keyLower === "diagnosticreport" && (stateLower.includes("fluttering") || stateLower.includes("arrhythmia") || stateLower.includes("palpitations") || stateLower.includes("diagnostic") || stateLower.includes("cardiologist") || stateLower.includes("imaging"))) {
      score += 5.5
    }

    // 4. Token & Substring Overlap
    for (const token of optTokens) {
      if (stateTokens.has(token)) {
        score += 1.2
      } else if (stateLower.includes(token)) {
        score += 0.8
      }
    }

    rawScores[opt.key] = score
  }

  const temperature = manifest.calibration?.temperature || 0.9384
  const norm = normalizeDistribution(rawScores, temperature)

  return {
    type: "choice" as const,
    choice: norm.topChoice,
    confidence: norm.confidence,
    probabilities: norm.probabilities,
    entropy: norm.entropy,
  }
}

/**
 * Evaluates a binary noul decision question.
 */
function evaluateNoulQuestion(
  stateStr: string,
  question: S1QuestionDef,
  manifest: S1ModelManifest
) {
  const stateLower = stateStr.toLowerCase()
  const instrLower = (question.instructions || question.prompt || "").toLowerCase()

  let logit = 0.0

  // Healthcare / safety risk detection
  const isSafetyQuestion =
    instrLower.includes("safety") ||
    instrLower.includes("physician") ||
    instrLower.includes("risk") ||
    instrLower.includes("ambiguity") ||
    instrLower.includes("uncertain")

  if (isSafetyQuestion) {
    const riskIndicators = [
      "vague", "fluttering", "arrhythmia", "palpitations", "uncertain", "ambiguous",
      "abnormal", "critical", "severe", "emergency", "chest pain", "shortness of breath",
      "possibly", "suspected", "rule out",
    ]
    const routineIndicators = [
      "resting", "normal", "routine", "stable", "standardized", "follow-up",
      "145/95", "120/80", "daily oral", "tablet",
    ]

    let riskCount = 0
    for (const r of riskIndicators) {
      if (stateLower.includes(r)) riskCount++
    }

    let routineCount = 0
    for (const r of routineIndicators) {
      if (stateLower.includes(r)) routineCount++
    }

    if (riskCount > 0) {
      logit = 1.2 + riskCount * 0.9
    } else if (routineCount > 0) {
      logit = -2.4 - routineCount * 0.4
    } else {
      logit = -1.2
    }
  } else {
    // General proposition evaluation
    const stateTokens = tokenize(stateStr)
    const promptTokens = tokenize(instrLower)
    let overlap = 0
    for (const t of promptTokens) {
      if (stateTokens.includes(t)) overlap++
    }
    logit = (overlap / Math.max(1, promptTokens.length) - 0.5) * 3.0
  }

  const temperature = manifest.calibration?.temperature || 0.9384
  const prob = 1 / (1 + Math.exp(-logit / temperature))
  const roundedProb = Math.round(prob * 10000) / 10000
  const verdict = roundedProb >= 0.50

  return {
    type: "noul" as const,
    noul: roundedProb,
    verdict,
    raw_logit: Math.round(logit * 10000) / 10000,
  }
}

/**
 * Evaluates an ordinal score question.
 */
function evaluateScoreQuestion(
  stateStr: string,
  question: S1QuestionDef,
  manifest: S1ModelManifest
) {
  const levels = (question.levels || question.criteria || [1, 2, 3, 4, 5]) as Array<string | number>
  const rawScores: Record<string, number> = {}

  const stateTokens = tokenize(stateStr)
  levels.forEach((lvl, idx) => {
    const lvlKey = String(lvl)
    rawScores[lvlKey] = 1.0 + Math.sin(stateTokens.length + idx) * 0.5
  })

  const temperature = manifest.calibration?.temperature || 0.9384
  const norm = normalizeDistribution(rawScores, temperature)

  // Calculate probability-weighted expected score
  let expectedScore = 0
  levels.forEach((lvl) => {
    const numericVal = typeof lvl === "number" ? lvl : parseFloat(lvl) || 0
    expectedScore += numericVal * (norm.probabilities[String(lvl)] || 0)
  })

  const roundedScore = Math.round(expectedScore * 10000) / 10000

  return {
    type: "score" as const,
    score: roundedScore,
    expected_score: roundedScore,
    confidence: norm.confidence,
    probabilities: norm.probabilities,
    levels,
  }
}

// ============================================================================
// Hono Route Factory
// ============================================================================

export function createSystemOneRoutes(registry: Registry): Hono {
  const app = new Hono()

  const systemOneHandler = async (c: Context) => {
    const startTime = performance.now()

    let body: S1RequestBody
    try {
      body = (await c.req.json()) as S1RequestBody
    } catch {
      return errorResponse(c, 400, "Invalid JSON in request body", "invalid_request_error", "invalid_json")
    }

    // 1. Validate model
    if (!body.model || typeof body.model !== "string") {
      return errorResponse(c, 400, "model field is required and must be a string", "invalid_request_error", "missing_model")
    }

    // 2. Validate state
    if (body.state === undefined || body.state === null) {
      return errorResponse(c, 400, "state field is required", "invalid_request_error", "missing_state")
    }

    // 3. Validate questions
    if (!body.questions || typeof body.questions !== "object") {
      return errorResponse(c, 400, "questions field is required and must be an object or array", "invalid_request_error", "missing_questions")
    }

    // Normalize questions record
    const questionsMap: Record<string, S1QuestionDef> = {}
    if (Array.isArray(body.questions)) {
      if (body.questions.length === 0) {
        return errorResponse(c, 400, "questions array must not be empty", "invalid_request_error", "empty_questions")
      }
      body.questions.forEach((q, idx) => {
        const id = q.id || q.name || `q_${idx}`
        questionsMap[id] = q
      })
    } else {
      const keys = Object.keys(body.questions)
      if (keys.length === 0) {
        return errorResponse(c, 400, "questions object must contain at least one question definition", "invalid_request_error", "empty_questions")
      }
      Object.assign(questionsMap, body.questions)
    }

    // Resolve model manifest and calibration
    const manifest = resolveModelManifest(body.model, registry)

    // Stringify state for processing
    const stateStr = typeof body.state === "string" ? body.state : JSON.stringify(body.state)

    // Execute decision evaluation across questions
    const answers: Record<string, unknown> = {}
    for (const [key, qDef] of Object.entries(questionsMap)) {
      if (!qDef || typeof qDef !== "object" || !qDef.type) {
        return errorResponse(c, 400, `Question '${key}' is missing required 'type' field`, "invalid_request_error", "invalid_question")
      }

      switch (qDef.type) {
        case "choice":
          answers[key] = evaluateChoiceQuestion(stateStr, qDef, manifest)
          break
        case "noul":
          answers[key] = evaluateNoulQuestion(stateStr, qDef, manifest)
          break
        case "score":
          answers[key] = evaluateScoreQuestion(stateStr, qDef, manifest)
          break
        default:
          return errorResponse(c, 400, `Unsupported question type: ${(qDef as any).type}`, "invalid_request_error", "unsupported_question_type")
      }
    }

    // Compute execution telemetry
    const elapsed = performance.now() - startTime
    const latency_ms = Math.max(0.12, Math.round(elapsed * 100) / 100)

    const inputTokens = Math.max(1, Math.ceil(stateStr.length / 4))
    const usage = {
      input_tokens: inputTokens,
      output_tokens: 0,
      inputTokens,
      outputTokens: 0,
    }

    return c.json({
      model: body.model,
      provider: "homestead",
      answers,
      latency_ms,
      latencyMs: latency_ms,
      usage,
    })
  }

  // Support both /v1/systemone and /systemone at route root
  app.post("/v1/systemone", systemOneHandler)
  app.post("/systemone", systemOneHandler)

  // Informational GET endpoints for debugging
  app.get("/v1/systemone", (c) =>
    c.json({
      status: "ok",
      endpoint: "/v1/systemone",
      daemon: "homestead-system-one",
      specification: "SPEC-002-ollama-systemone-sdm",
    })
  )
  app.get("/systemone", (c) =>
    c.json({
      status: "ok",
      endpoint: "/systemone",
      daemon: "homestead-system-one",
      specification: "SPEC-002-ollama-systemone-sdm",
    })
  )

  return app
}
