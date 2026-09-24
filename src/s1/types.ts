import type { ModelRecord } from "../types.js"

// ---------------------------------------------------------------------------
// S1 (System-1) Question Types
// ---------------------------------------------------------------------------

export type S1QuestionType = "choice" | "score" | "noul"

export interface ChoiceOption {
  id?: string
  label: string
  description?: string
  value?: string
}

export interface ChoiceQuestion {
  id: string
  type: "choice"
  prompt: string
  /** 2 to 255 discrete options */
  options: string[] | ChoiceOption[]
  /** Optional rubric or criteria for disambiguation */
  rubric?: string | Record<string, string>
  criteria?: string[]
  metadata?: Record<string, unknown>
}

export interface ScoreLevel {
  score: number
  label?: string
  description?: string
}

export interface ScoreQuestion {
  id: string
  type: "score"
  prompt: string
  /** Minimum score level (default: 1) */
  min?: number
  /** Maximum score level (default: 5 or 10, max 10) */
  max?: number
  /** 2 to 10 ordered levels with optional descriptions */
  levels?: number[] | ScoreLevel[]
  /** Optional rubric specifying criteria per score tier */
  rubric?: string | Record<string, string>
  criteria?: string[]
  metadata?: Record<string, unknown>
}

export interface NoulQuestion {
  id: string
  type: "noul"
  prompt: string
  /** Criteria to evaluate against for binary verdict */
  criteria?: string[]
  /** Rubric detailing conditions for true/false */
  rubric?: string | Record<string, string>
  metadata?: Record<string, unknown>
}

export type S1Question = ChoiceQuestion | ScoreQuestion | NoulQuestion

// ---------------------------------------------------------------------------
// S1 Answer Types
// ---------------------------------------------------------------------------

export interface ChoiceAnswer {
  question_id: string
  type: "choice"
  /** Chosen option label or value */
  value: string
  /** 0-based index of chosen option */
  index: number
  /** Calibrated confidence score in range [0, 1] */
  confidence: number
  /** Probability distribution across options */
  probabilities: Record<string, number>
  /** Log probabilities if available */
  log_probs?: Record<string, number>
  /** Raw logits if requested */
  logits?: Record<string, number>
}

export interface ScoreAnswer {
  question_id: string
  type: "score"
  /** Continuous expected score E[S] = sum(s_i * P(s_i)) */
  expected_score: number
  /** Discrete most likely level or rounded expected level */
  value: number
  /** Confidence score in range [0, 1] */
  confidence: number
  /** Probability distribution across score levels */
  probabilities: Record<number, number>
  /** Log probabilities if available */
  log_probs?: Record<number, number>
  /** Min and Max bounds used */
  bounds?: { min: number; max: number }
}

export interface NoulAnswer {
  question_id: string
  type: "noul"
  /** Binary decision (true = yes / pass, false = no / fail) */
  value: boolean
  /** Calibrated probability P(true) in range [0, 1] */
  probability: number
  /** Calibrated log-odds: ln(p / (1 - p)) */
  log_odds: number
  /** Confidence score in range [0.5, 1.0]: max(p, 1 - p) */
  confidence: number
}

export type S1Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer

// ---------------------------------------------------------------------------
// S1 Schema and Wire Protocols
// ---------------------------------------------------------------------------

export interface S1Schema {
  id: string
  name?: string
  description?: string
  version?: string
  questions: S1Question[]
  compiled_prefix?: string
  hash?: string
  metadata?: Record<string, unknown>
}

export type S1AdapterArchitecture = "auto" | "ar-logit" | "decider" | "laya" | "nanojev" | (string & {})

export interface SystemOneRequest {
  /** Input state: raw text prompt, JSON context, or conversation messages */
  state: string | Record<string, unknown> | Array<{ role: string; content: string }>
  /** List of questions to evaluate against state */
  questions?: S1Question[]
  /** Reference to pre-registered schema ID or inline schema */
  schema?: string | S1Schema
  /** Target model name or identifier */
  model?: string
  /** Explicit adapter architecture selection */
  adapter?: S1AdapterArchitecture
  /** Sampling temperature (default: 0.0 for deterministic argmax) */
  temperature?: number
  /** Optional layout preference for slot models: 'state-first' | 'schema-first' */
  layout?: "state-first" | "schema-first"
  /** Optional execution options */
  options?: {
    return_logits?: boolean
    return_log_probs?: boolean
    top_k?: number
    use_prefix_cache?: boolean
    timeout_ms?: number
    [key: string]: unknown
  }
}

export interface SystemOneUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  latency_ms: number
  cached_prefix?: boolean
}

export interface SystemOneResponse {
  id: string
  model: string
  adapter: string
  answers: Record<string, S1Answer>
  usage: SystemOneUsage
  created_at: string
}

// ---------------------------------------------------------------------------
// Convenience Wire Protocol Payloads (/decide & /score)
// ---------------------------------------------------------------------------

export interface DecideRequest {
  state: string | Record<string, unknown> | Array<{ role: string; content: string }>
  question: string | ChoiceQuestion | NoulQuestion
  options?: string[]
  rubric?: string | Record<string, string>
  model?: string
  adapter?: S1AdapterArchitecture
}

export interface DecideResponse {
  decision: string | boolean
  confidence: number
  probabilities: Record<string, number> | number
  answer: ChoiceAnswer | NoulAnswer
  latency_ms: number
}

export interface ScoreRequest {
  state: string | Record<string, unknown> | Array<{ role: string; content: string }>
  question?: string | ScoreQuestion
  min?: number
  max?: number
  levels?: number[]
  rubric?: string | Record<string, string>
  model?: string
  adapter?: S1AdapterArchitecture
}

export interface ScoreResponse {
  expected_score: number
  value: number
  confidence: number
  distribution: Record<number, number>
  answer: ScoreAnswer
  latency_ms: number
}

// ---------------------------------------------------------------------------
// Adapter Interface
// ---------------------------------------------------------------------------

export interface S1Adapter {
  name: string
  architecture: S1AdapterArchitecture
  priority: number
  canHandle(model: ModelRecord | string): boolean
  evaluate(request: SystemOneRequest, model?: ModelRecord): Promise<SystemOneResponse>
}

// ---------------------------------------------------------------------------
// Mathematical Helpers
// ---------------------------------------------------------------------------

/**
 * Computes numerically stable softmax over an array of logits.
 */
export function softmax(logits: number[], temperature = 1.0): number[] {
  if (logits.length === 0) return []
  const temp = Math.max(temperature, 1e-6)
  const scaled = logits.map((z) => z / temp)
  const max = Math.max(...scaled)
  const exp = scaled.map((z) => Math.exp(z - max))
  const sum = exp.reduce((acc, val) => acc + val, 0)
  if (sum === 0) {
    const uniform = 1 / logits.length
    return logits.map(() => uniform)
  }
  return exp.map((val) => val / sum)
}

/**
 * Computes the continuous expected score E[S] = sum(score_i * P(score_i)).
 */
export function calculateExpectedScore(distribution: Record<number, number>): number {
  let expected = 0
  let totalProb = 0
  for (const [levelStr, prob] of Object.entries(distribution)) {
    const level = Number(levelStr)
    expected += level * prob
    totalProb += prob
  }
  if (totalProb <= 0) return 0
  return expected / totalProb
}

/**
 * Computes calibrated log-odds: ln(p / (1 - p)) with clamping for numerical stability.
 */
export function calculateLogOdds(p: number, eps = 1e-7): number {
  const clamped = Math.max(eps, Math.min(1 - eps, p))
  return Math.log(clamped / (1 - clamped))
}

/**
 * Calculates confidence from binary probability: max(p, 1 - p).
 */
export function calculateBinaryConfidence(p: number): number {
  return Math.max(p, 1 - p)
}
