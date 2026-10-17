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

export const CANONICAL_AGENTIC_OPTIONS = [
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

export const CANONICAL_AGENTIC_CRITERIA: Record<string, string> = {
  read: "Inspect local file contents or configuration files",
  bash: "Execute shell commands, test suites, or terminal scripts",
  view_file: "Inspect workspace project file or AST tree",
  tier_frontier: "Escalate to frontier reasoning model for complex architecture",
  edit_file: "Modify or patch source file",
  write: "Create new file on filesystem",
  grep_search: "Search regex patterns across files or server logs",
  run_command: "Execute workspace tools",
  tier_cloud: "Cloud model tier escalation",
  tier_local: "Local fast model tier",
}

export const CANONICAL_SERVICE_OPTIONS = [
  "offer-refund",
  "shipping-status",
  "verify-identity",
  "update-order",
  "search-policy",
  "promo-code",
  "make-password",
  "pull-up-account",
  "update-account",
  "validate-purchase",
  "notify-team",
  "record-reason",
  "make-purchase",
  "subscription-status",
  "search-pricing",
  "search-faq",
  "send-link",
  "instructions",
  "log-out-in",
  "try-again",
  "enter-details",
  "browse-catalog",
  "greeting-faq",
  "out-of-scope",
  "tier-frontier",
  "escalate-human",
]

export const CANONICAL_SERVICE_CRITERIA: Record<string, string> = {
  "offer-refund": "Customer was charged incorrectly, double charged, or requests refund or compensation",
  "shipping-status": "Inquire about shipment, tracking, delivery status, courier, or missing package",
  "verify-identity": "Authentication, security credentials, 2FA, OTP, or identity verification",
  "update-order": "Modify order, change size, color, item, quantity, or shipping address",
  "search-policy": "Warranty, return window, terms of service, policy guidelines, or return rules",
  "promo-code": "Discount, promo coupon, voucher application at checkout, or promotional credits",
  "make-password": "Reset, change, or create account login password",
  "pull-up-account": "Retrieve customer account profile, transaction history, or customer record",
  "update-account": "Update account profile, email, phone number, or contact preferences",
  "validate-purchase": "Validate transaction, proof of purchase, order receipt, or order ID",
  "notify-team": "Escalate or notify specialized support tier or internal department",
  "record-reason": "Log customer cancellation reason, return reason, or feedback",
  "make-purchase": "Complete checkout, purchase merchandise, or pay outstanding balance",
  "subscription-status": "Check recurring subscription status, renewal date, or cancel subscription",
  "search-pricing": "Pricing inquiry, rate card, cost calculation, plan tiers, or quotes",
  "search-faq": "Frequently asked questions and knowledge base articles",
  "send-link": "Send direct URL link, documentation link, or self-service link to customer",
  "instructions": "Step-by-step guidance, setup instructions, or how-to guide",
  "log-out-in": "Sign out and sign back into customer account",
  "try-again": "Retry failed operation, transaction retry, or page refresh",
  "enter-details": "Provide billing or shipping details, form filling, or address entry",
  "browse-catalog": "Search products, browse inventory, inspect item catalog, availability, apparel, or goods",
  "greeting-faq": "Greetings, pleasantries, small talk, thank you, who are you, or conversational chat",
  "out-of-scope": "Unrelated topic, programming code, general world knowledge, or unanswerable query",
  "tier-frontier": "Complex multi-step reasoning, architectural problem, or edge case escalation",
  "escalate-human": "Customer demands live human agent, supervisor, or files formal complaint",
}

export const CANONICAL_TURN_TYPE_OPTIONS = [
  "greeting_chitchat",
  "faq_policy",
  "actionable_request",
  "escalate_human",
  "out_of_scope",
]

export const CANONICAL_TURN_TYPE_CRITERIA: Record<string, string> = {
  greeting_chitchat: "Customer is greeting, exchanging pleasantries, saying goodbye, or asking bot identity",
  faq_policy: "Customer is asking informational questions about company policies, shipping rates, hours, or general FAQ",
  actionable_request: "Customer requires a concrete backend transaction, lookup, modification, refund, or account change",
  escalate_human: "Customer is frustrated, complaining, or explicitly demanding a human supervisor or live representative",
  out_of_scope: "Query is unrelated to customer support, e.g. general knowledge, programming code, weather, or creative writing",
}

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
          } else if (normalized.includes("service") || normalized.includes("support")) {
            parsed.options = CANONICAL_SERVICE_OPTIONS
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
// Single Forward-Pass Silicon Decision Engine (Ollama MLX Native)
// ============================================================================

/**
 * Resolves the underlying physical silicon Ollama model tag.
 */
export function resolveTargetOllamaModel(
  requestedModel: string,
  stateStr: string,
  manifest: S1ModelManifest
): string {
  const norm = requestedModel.trim().toLowerCase()

  if (norm === "s1/homerouter-service-420m" || norm.includes("service") || norm.includes("support")) {
    return "s1/homerouter-service-420m"
  }

  if (norm === "s1/homerouter-agentic-420m" || norm.includes("agentic") || norm.includes("coder") || norm.includes("dev")) {
    return "s1/homerouter-agentic-420m"
  }

  // Dual homerouter automatic resolution based on manifest options and state context
  if (norm.includes("homerouter") || norm.includes("hrouter") || norm === "local") {
    const isAgenticState =
      /(\bcat\b|\bgrep\b|\bbun\b|\bnpm\b|\bpytest\b|\btest\b|\bcompile\b|\bterminal\b|\bsocket\b|\bport\b|\barchitect\b|\bconsensus\b|\bfile\b|\bsrc\/|\bpath\b)/i.test(
        stateStr
      ) ||
      (manifest.options && manifest.options.some((o) => CANONICAL_AGENTIC_OPTIONS.includes(o)))

    return isAgenticState ? "s1/homerouter-agentic-420m" : "s1/homerouter-service-420m"
  }

  return requestedModel
}

/**
 * Executes a single-forward-pass System-1 decision on physical silicon via Ollama's /v1/systemone MLX runner.
 * No JavaScript keyword heuristics or simulated scoring fallbacks.
 */
export async function executeSiliconSystemOne(
  requestedModel: string,
  stateStr: string,
  questionsMap: Record<string, S1QuestionDef>,
  manifest: S1ModelManifest
): Promise<{ answers: Record<string, unknown>; usage: { input_tokens: number; output_tokens: number } }> {
  const targetModel = resolveTargetOllamaModel(requestedModel, stateStr, manifest)

  const ollamaQuestions: Record<string, any> = {}

  for (const [key, qDef] of Object.entries(questionsMap)) {
    if (qDef.type === "choice") {
      let criteria: Record<string, string> = {}
      const getDesc = (opt: string) =>
        CANONICAL_AGENTIC_CRITERIA[opt] ||
        CANONICAL_SERVICE_CRITERIA[opt] ||
        CANONICAL_TURN_TYPE_CRITERIA[opt] ||
        opt

      if ((key === "turn_type" || key === "triage_tier" || key === "meta_tier") && !qDef.criteria && !qDef.options) {
        for (const opt of CANONICAL_TURN_TYPE_OPTIONS) {
          criteria[opt] = CANONICAL_TURN_TYPE_CRITERIA[opt] || opt
        }
      } else if (qDef.criteria && typeof qDef.criteria === "object" && !Array.isArray(qDef.criteria)) {
        for (const [k, v] of Object.entries(qDef.criteria)) {
          criteria[k] = typeof v === "string" && v !== k ? v : getDesc(k)
        }
      } else if (Array.isArray(qDef.criteria)) {
        for (const k of qDef.criteria) {
          criteria[String(k)] = getDesc(String(k))
        }
      } else if (qDef.options && typeof qDef.options === "object" && !Array.isArray(qDef.options)) {
        for (const [k, v] of Object.entries(qDef.options)) {
          criteria[k] = typeof v === "string" && v !== k ? v : getDesc(k)
        }
      } else if (Array.isArray(qDef.options)) {
        for (const k of qDef.options) {
          criteria[String(k)] = getDesc(String(k))
        }
      } else if (manifest.options && manifest.options.length > 0) {
        for (const k of manifest.options) {
          criteria[k] = getDesc(k)
        }
      } else {
        for (const k of CANONICAL_SERVICE_OPTIONS) {
          criteria[k] = getDesc(k)
        }
      }

      // Ollama MLX runner requires between 2 and 26 candidates
      const entries = Object.entries(criteria)
      if (entries.length > 26) {
        const stateLower = stateStr.toLowerCase()
        const sortedEntries = entries.sort((a, b) => {
          const aMatch = stateLower.includes(a[0].toLowerCase().replace(/-/g, " ")) ? 1 : 0
          const bMatch = stateLower.includes(b[0].toLowerCase().replace(/-/g, " ")) ? 1 : 0
          if (aMatch !== bMatch) return bMatch - aMatch
          // Drop granular shopping garment searches when prioritizing core service actions
          const aGarment = /^(search-(boots|jacket|jeans|shirt))$/.test(a[0]) ? 1 : 0
          const bGarment = /^(search-(boots|jacket|jeans|shirt))$/.test(b[0]) ? 1 : 0
          return aGarment - bGarment
        })
        criteria = Object.fromEntries(sortedEntries.slice(0, 26))
      } else if (entries.length < 2) {
        criteria["other"] = "other"
      }

      ollamaQuestions[key] = {
        type: "choice",
        instructions: qDef.instructions || qDef.prompt || `Select candidate for ${key}`,
        criteria,
      }
    } else if (qDef.type === "noul") {
      let criteria: Record<string, string> = {
        true: "Affirmative or positive indication",
        false: "Negative or absent indication",
      }

      if (qDef.criteria && typeof qDef.criteria === "object" && !Array.isArray(qDef.criteria)) {
        const c = qDef.criteria as { true?: unknown; false?: unknown }
        if (c.true !== undefined && c.false !== undefined) {
          criteria = {
            true: String(c.true),
            false: String(c.false),
          }
        }
      }

      ollamaQuestions[key] = {
        type: "noul",
        instructions: qDef.instructions || qDef.prompt || `Evaluate condition for ${key}`,
        criteria,
      }
    } else if (qDef.type === "score") {
      let criteria: string[] = ["1", "2", "3", "4", "5"]
      if (Array.isArray(qDef.criteria) && qDef.criteria.length >= 2) {
        criteria = qDef.criteria.map(String).slice(0, 10)
      } else if (Array.isArray(qDef.levels) && qDef.levels.length >= 2) {
        criteria = qDef.levels.map(String).slice(0, 10)
      }

      ollamaQuestions[key] = {
        type: "score",
        instructions: qDef.instructions || qDef.prompt || `Rate level for ${key}`,
        criteria,
      }
    }
  }

  const ollamaHost = process.env.OLLAMA_HOST || process.env.OLLAMA_API_URL || "http://127.0.0.1:11434"
  const ollamaUrl = `${ollamaHost.replace(/\/+$/, "")}/v1/systemone`

  const resp = await fetch(ollamaUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: targetModel,
      state: stateStr,
      questions: ollamaQuestions,
    }),
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "")
    throw new Error(`Ollama physical silicon execution failed [${resp.status}]: ${errText}`)
  }

  const data = (await resp.json()) as any

  const answers: Record<string, unknown> = {}
  for (const [key, qDef] of Object.entries(questionsMap)) {
    const ans = data.answers?.[key]
    if (!ans) continue

    if (qDef.type === "choice") {
      let probabilities = ans.probabilities || {}
      let topChoice = ans.choice
      let confidence = ans.confidence ?? 0.0
      let entropy = ans.entropy

      if (Object.keys(probabilities).length > 0) {
        const norm = normalizeDistribution(probabilities, 1.0)
        probabilities = norm.probabilities
        topChoice = ans.choice || norm.topChoice
        confidence = ans.confidence !== undefined ? ans.confidence : norm.confidence
        entropy = norm.entropy
      }

      answers[key] = {
        type: "choice",
        choice: topChoice,
        confidence: Math.round(confidence * 10000) / 10000,
        probabilities,
        entropy: entropy !== undefined ? Math.round(entropy * 10000) / 10000 : undefined,
      }
    } else if (qDef.type === "noul") {
      const noulVal = typeof ans.noul === "number" ? Math.round(ans.noul * 10000) / 10000 : 0.0
      const threshold = manifest.calibration?.recommended_threshold ?? 0.50
      const verdict = noulVal >= threshold
      answers[key] = {
        type: "noul",
        noul: noulVal,
        verdict,
        confidence: Math.round(Math.abs(noulVal - 0.5) * 2 * 10000) / 10000,
      }
    } else if (qDef.type === "score") {
      answers[key] = {
        type: "score",
        score: typeof ans.score === "number" ? Math.round(ans.score * 10000) / 10000 : ans.score,
        expected_score: typeof ans.score === "number" ? Math.round(ans.score * 10000) / 10000 : ans.score,
        confidence: typeof ans.confidence === "number" ? Math.round(ans.confidence * 10000) / 10000 : 0.0,
        probabilities: ans.probabilities,
        legend: ans.legend,
        levels: qDef.levels || qDef.criteria || [1, 2, 3, 4, 5],
      }
    }
  }

  const inputTokens = data.usage?.input_tokens ?? Math.max(1, Math.ceil(stateStr.length / 4))
  const usage = {
    input_tokens: inputTokens,
    output_tokens: 0,
    inputTokens,
    outputTokens: 0,
  }

  return { answers, usage }
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

    // Validate each question definition
    for (const [key, qDef] of Object.entries(questionsMap)) {
      if (!qDef || typeof qDef !== "object" || !qDef.type) {
        return errorResponse(c, 400, `Question '${key}' is missing required 'type' field`, "invalid_request_error", "invalid_question")
      }
      if (qDef.type !== "choice" && qDef.type !== "noul" && qDef.type !== "score") {
        return errorResponse(c, 400, `Unsupported question type: ${(qDef as any).type}`, "invalid_request_error", "unsupported_question_type")
      }
    }

    // Resolve model manifest and calibration
    const manifest = resolveModelManifest(body.model, registry)

    // Stringify state for processing
    const stateStr = typeof body.state === "string" ? body.state : JSON.stringify(body.state)

    // Execute real silicon forward pass on Ollama
    let siliconResult: { answers: Record<string, unknown>; usage: { input_tokens: number; output_tokens: number } }
    try {
      siliconResult = await executeSiliconSystemOne(body.model, stateStr, questionsMap, manifest)
    } catch (err: any) {
      return errorResponse(
        c,
        503,
        `System-1 silicon execution failed: ${err?.message || String(err)}`,
        "server_error",
        "ollama_silicon_error"
      )
    }

    // Compute execution telemetry
    const elapsed = performance.now() - startTime
    const latency_ms = Math.max(0.12, Math.round(elapsed * 100) / 100)

    const usage = {
      input_tokens: siliconResult.usage.input_tokens,
      output_tokens: 0,
      inputTokens: siliconResult.usage.input_tokens,
      outputTokens: 0,
    }

    return c.json({
      model: body.model,
      provider: "homestead",
      answers: siliconResult.answers,
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
