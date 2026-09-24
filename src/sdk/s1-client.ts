import type {
  SystemOneRequest,
  SystemOneResponse,
  DecideRequest,
  DecideResponse,
  ScoreRequest,
  ScoreResponse,
  S1Question,
  ChoiceQuestion,
  ScoreQuestion,
  NoulQuestion,
  ChoiceOption,
  S1Schema,
  S1AdapterArchitecture,
} from "../s1/types.js"

export interface S1ClientConfig {
  /** Base URL for Homestead or TypeSafe API (default: "http://127.0.0.1:18765") */
  baseUrl?: string
  /** Optional API Key for authenticated endpoints */
  apiKey?: string
  /** Default model identifier */
  defaultModel?: string
  /** Default adapter architecture */
  defaultAdapter?: S1AdapterArchitecture
  /** Custom fetch implementation (optional) */
  fetch?: typeof fetch
  /** Custom headers */
  headers?: Record<string, string>
  /** Timeout in milliseconds (default: 30000) */
  timeoutMs?: number
}

export class HomesteadS1Client {
  private baseUrl: string
  private apiKey?: string
  private defaultModel?: string
  private defaultAdapter?: S1AdapterArchitecture
  private fetchImpl: typeof fetch
  private customHeaders: Record<string, string>
  private timeoutMs: number

  constructor(config: S1ClientConfig = {}) {
    this.baseUrl = (config.baseUrl ?? process.env.HOMESTEAD_API_URL ?? "http://127.0.0.1:18765").replace(/\/+$/, "")
    this.apiKey = config.apiKey ?? process.env.TYPESAFE_API_KEY ?? process.env.HOMESTEAD_API_KEY
    this.defaultModel = config.defaultModel
    this.defaultAdapter = config.defaultAdapter
    this.fetchImpl = config.fetch ?? (typeof globalThis !== "undefined" ? globalThis.fetch : fetch)
    this.customHeaders = config.headers ?? {}
    this.timeoutMs = config.timeoutMs ?? 30_000
  }

  /**
   * Executes a full SystemOneRequest with structured questions or compiled schema.
   */
  async systemOne(request: SystemOneRequest): Promise<SystemOneResponse> {
    const payload: SystemOneRequest = {
      ...request,
      model: request.model ?? this.defaultModel,
      adapter: request.adapter ?? this.defaultAdapter,
    }

    return this.postJson<SystemOneResponse>("/v1/systemone", payload)
  }

  /**
   * Evaluates a single decision (Choice or Binary Noul) against the given state.
   */
  async decide(
    state: string | Record<string, unknown> | Array<{ role: string; content: string }>,
    question: string | ChoiceQuestion | NoulQuestion,
    options?: string[],
    opts: {
      rubric?: string | Record<string, string>
      model?: string
      adapter?: S1AdapterArchitecture
    } = {}
  ): Promise<DecideResponse> {
    const payload: DecideRequest = {
      state,
      question,
      options,
      rubric: opts.rubric,
      model: opts.model ?? this.defaultModel,
      adapter: opts.adapter ?? this.defaultAdapter,
    }

    return this.postJson<DecideResponse>("/decide", payload)
  }

  /**
   * Evaluates an expected continuous score E[S] and score distribution.
   */
  async score(
    state: string | Record<string, unknown> | Array<{ role: string; content: string }>,
    question?: string | ScoreQuestion,
    opts: {
      min?: number
      max?: number
      levels?: number[]
      rubric?: string | Record<string, string>
      model?: string
      adapter?: S1AdapterArchitecture
    } = {}
  ): Promise<ScoreResponse> {
    const payload: ScoreRequest = {
      state,
      question,
      min: opts.min,
      max: opts.max,
      levels: opts.levels,
      rubric: opts.rubric,
      model: opts.model ?? this.defaultModel,
      adapter: opts.adapter ?? this.defaultAdapter,
    }

    return this.postJson<ScoreResponse>("/score", payload)
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const cleanPath = path.startsWith("/") ? path : `/${path}`
    const url = `${this.baseUrl}${cleanPath}`

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Homestead-Client": "homestead-s1-sdk",
      ...this.customHeaders,
    }

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`
    }

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })

    if (!res.ok) {
      let errorDetail = ""
      try {
        const errorJson = (await res.json()) as { error?: { message?: string; code?: string } }
        errorDetail = errorJson.error?.message || JSON.stringify(errorJson)
      } catch {
        errorDetail = await res.text()
      }
      throw new Error(`Homestead S1 API Error (${res.status}): ${errorDetail}`)
    }

    return (await res.json()) as T
  }
}

// ---------------------------------------------------------------------------
// Ergonomic Question & Schema Builders
// ---------------------------------------------------------------------------

/**
 * Creates a Choice question definition.
 */
export function choice(
  id: string,
  prompt: string,
  options: string[] | ChoiceOption[],
  rubric?: string | Record<string, string>
): ChoiceQuestion {
  return {
    id,
    type: "choice",
    prompt,
    options,
    rubric,
  }
}

/**
 * Creates a Score question definition.
 */
export function score(
  id: string,
  prompt: string,
  min = 1,
  max = 5,
  rubric?: string | Record<string, string>
): ScoreQuestion {
  return {
    id,
    type: "score",
    prompt,
    min,
    max,
    rubric,
  }
}

/**
 * Creates a Noul (calibrated binary) question definition.
 */
export function noul(
  id: string,
  prompt: string,
  criteria?: string[],
  rubric?: string | Record<string, string>
): NoulQuestion {
  return {
    id,
    type: "noul",
    prompt,
    criteria,
    rubric,
  }
}

/**
 * Creates an S1Schema definition.
 */
export function defineSchema(
  id: string,
  questions: S1Question[],
  options: { name?: string; description?: string; version?: string; metadata?: Record<string, unknown> } = {}
): S1Schema {
  return {
    id,
    questions,
    name: options.name,
    description: options.description,
    version: options.version,
    metadata: options.metadata,
  }
}
