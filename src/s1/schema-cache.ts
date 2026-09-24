import { createHash } from "node:crypto"
import type { S1Schema, S1Question, ChoiceQuestion, ScoreQuestion } from "./types.js"

export interface CompiledSchema {
  id: string
  hash: string
  name?: string
  questions: S1Question[]
  compiledPromptPrefix: string
  slotKeys: string[]
  questionMap: Map<string, S1Question>
  tokenMap?: Map<string, number[]>
  metadata?: Record<string, unknown>
  createdAt: number
  lastAccessedAt: number
}

export interface CachedPrefix {
  key: string
  schemaId: string
  prefixText: string
  tokenIds?: number[]
  kvHandle?: string
  createdAt: number
  expiresAt: number
  accessCount: number
}

export interface SchemaCacheStats {
  hits: number
  misses: number
  hitRate: number
  schemaCount: number
  prefixCount: number
}

export class SchemaCache {
  private schemas = new Map<string, CompiledSchema>()
  private hashToId = new Map<string, string>()
  private prefixCache = new Map<string, CachedPrefix>()
  private maxSchemas: number
  private maxPrefixes: number
  private defaultTtlMs: number

  private stats = {
    hits: 0,
    misses: 0,
  }

  constructor(options: { maxSchemas?: number; maxPrefixes?: number; ttlMs?: number } = {}) {
    this.maxSchemas = options.maxSchemas ?? 1000
    this.maxPrefixes = options.maxPrefixes ?? 2000
    this.defaultTtlMs = options.ttlMs ?? 3600_000 // 1 hour default
  }

  /**
   * Generates a deterministic SHA-256 hash for a set of questions or a schema.
   */
  public computeHash(questions: S1Question[] | S1Schema): string {
    const raw = Array.isArray(questions)
      ? questions.map((q) => this.canonicalizeQuestion(q))
      : {
          id: questions.id,
          questions: questions.questions.map((q) => this.canonicalizeQuestion(q)),
        }
    return createHash("sha256").update(JSON.stringify(raw)).digest("hex")
  }

  private canonicalizeQuestion(q: S1Question): Record<string, unknown> {
    if (q.type === "choice") {
      const cq = q as ChoiceQuestion
      const opts = Array.isArray(cq.options)
        ? cq.options.map((o) => (typeof o === "string" ? o : o.label))
        : []
      return { id: q.id, type: q.type, prompt: q.prompt, options: opts, rubric: q.rubric }
    }
    if (q.type === "score") {
      const sq = q as ScoreQuestion
      return { id: q.id, type: q.type, prompt: q.prompt, min: sq.min ?? 1, max: sq.max ?? 5, rubric: q.rubric }
    }
    return { id: q.id, type: q.type, prompt: q.prompt, criteria: q.criteria, rubric: q.rubric }
  }

  /**
   * Compiles questions into a structured schema with a prompt prefix representation.
   */
  public compile(questions: S1Question[], id?: string, name?: string): CompiledSchema {
    const hash = this.computeHash(questions)
    const schemaId = id || `schema-${hash.slice(0, 12)}`

    const existing = this.schemas.get(schemaId)
    if (existing && existing.hash === hash) {
      existing.lastAccessedAt = Date.now()
      return existing
    }

    const questionMap = new Map<string, S1Question>()
    const slotKeys: string[] = []
    const lines: string[] = ["[SCHEMA]"]

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]
      if (!q) continue
      questionMap.set(q.id, q)
      slotKeys.push(q.id)

      if (q.type === "choice") {
        const cq = q as ChoiceQuestion
        const optLabels = Array.isArray(cq.options)
          ? cq.options.map((o, idx) => {
              const label = typeof o === "string" ? o : o.label
              const char = String.fromCharCode(65 + idx)
              return `  (${char}) ${label}`
            }).join("\n")
          : ""
        lines.push(`Q${i + 1} [CHOICE] id="${q.id}": ${q.prompt}\n${optLabels}`)
      } else if (q.type === "score") {
        const sq = q as ScoreQuestion
        const min = sq.min ?? 1
        const max = sq.max ?? 5
        lines.push(`Q${i + 1} [SCORE] id="${q.id}" range=[${min}..${max}]: ${q.prompt}`)
      } else if (q.type === "noul") {
        lines.push(`Q${i + 1} [NOUL] id="${q.id}": ${q.prompt}`)
      }
    }
    lines.push("[/SCHEMA]")

    const compiledPromptPrefix = lines.join("\n")
    const compiled: CompiledSchema = {
      id: schemaId,
      hash,
      name,
      questions,
      compiledPromptPrefix,
      slotKeys,
      questionMap,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    }

    this.evictSchemaIfNecessary()
    this.schemas.set(schemaId, compiled)
    this.hashToId.set(hash, schemaId)
    return compiled
  }

  /**
   * Registers an S1Schema.
   */
  public register(schema: S1Schema): CompiledSchema {
    return this.compile(schema.questions, schema.id, schema.name)
  }

  /**
   * Retrieves a compiled schema by ID or hash.
   */
  public get(idOrHash: string): CompiledSchema | undefined {
    let schema = this.schemas.get(idOrHash)
    if (!schema) {
      const mappedId = this.hashToId.get(idOrHash)
      if (mappedId) {
        schema = this.schemas.get(mappedId)
      }
    }

    if (schema) {
      schema.lastAccessedAt = Date.now()
      this.stats.hits++
      return schema
    }

    this.stats.misses++
    return undefined
  }

  /**
   * Checks whether a schema is registered by ID or hash.
   */
  public has(idOrHash: string): boolean {
    return this.schemas.has(idOrHash) || this.hashToId.has(idOrHash)
  }

  /**
   * Retrieves or compiles on demand.
   */
  public getOrCompile(target: S1Schema | S1Question[] | string): CompiledSchema | undefined {
    if (typeof target === "string") {
      return this.get(target)
    }
    if (Array.isArray(target)) {
      const hash = this.computeHash(target)
      const existing = this.get(hash)
      if (existing) return existing
      return this.compile(target)
    }
    if (target && typeof target === "object" && "questions" in target) {
      const existing = this.get(target.id)
      if (existing) return existing
      return this.register(target)
    }
    return undefined
  }

  /**
   * Retrieves a cached KV prefix handle or token array.
   */
  public getPrefix(prefixKey: string): CachedPrefix | undefined {
    const entry = this.prefixCache.get(prefixKey)
    if (!entry) {
      this.stats.misses++
      return undefined
    }

    if (Date.now() > entry.expiresAt) {
      this.prefixCache.delete(prefixKey)
      this.stats.misses++
      return undefined
    }

    entry.accessCount++
    this.stats.hits++
    return entry
  }

  /**
   * Stores a compiled KV prefix in cache.
   */
  public setPrefix(
    prefixKey: string,
    schemaId: string,
    prefixText: string,
    options: { tokenIds?: number[]; kvHandle?: string; ttlMs?: number } = {}
  ): CachedPrefix {
    this.evictPrefixIfNecessary()
    const entry: CachedPrefix = {
      key: prefixKey,
      schemaId,
      prefixText,
      tokenIds: options.tokenIds,
      kvHandle: options.kvHandle,
      createdAt: Date.now(),
      expiresAt: Date.now() + (options.ttlMs ?? this.defaultTtlMs),
      accessCount: 1,
    }
    this.prefixCache.set(prefixKey, entry)
    return entry
  }

  /**
   * Evicts schemas when limit is exceeded using LRU.
   */
  private evictSchemaIfNecessary(): void {
    if (this.schemas.size < this.maxSchemas) return
    let oldestKey: string | null = null
    let oldestTime = Infinity
    for (const [key, item] of this.schemas.entries()) {
      if (item.lastAccessedAt < oldestTime) {
        oldestTime = item.lastAccessedAt
        oldestKey = key
      }
    }
    if (oldestKey) {
      const item = this.schemas.get(oldestKey)
      if (item) this.hashToId.delete(item.hash)
      this.schemas.delete(oldestKey)
    }
  }

  /**
   * Evicts prefixes when limit is exceeded or expired.
   */
  private evictPrefixIfNecessary(): void {
    const now = Date.now()
    for (const [key, item] of this.prefixCache.entries()) {
      if (now > item.expiresAt) {
        this.prefixCache.delete(key)
      }
    }
    if (this.prefixCache.size < this.maxPrefixes) return
    let lowestAccessKey: string | null = null
    let lowestAccess = Infinity
    for (const [key, item] of this.prefixCache.entries()) {
      if (item.accessCount < lowestAccess) {
        lowestAccess = item.accessCount
        lowestAccessKey = key
      }
    }
    if (lowestAccessKey) {
      this.prefixCache.delete(lowestAccessKey)
    }
  }

  /**
   * Removes a schema from cache.
   */
  public invalidate(idOrHash: string): boolean {
    const item = this.schemas.get(idOrHash)
    if (item) {
      this.hashToId.delete(item.hash)
      this.schemas.delete(idOrHash)
      return true
    }
    const id = this.hashToId.get(idOrHash)
    if (id) {
      this.hashToId.delete(idOrHash)
      this.schemas.delete(id)
      return true
    }
    return false
  }

  /**
   * Clears all caches and resets statistics.
   */
  public clear(): void {
    this.schemas.clear()
    this.hashToId.clear()
    this.prefixCache.clear()
    this.stats.hits = 0
    this.stats.misses = 0
  }

  /**
   * Returns cache metrics.
   */
  public getStats(): SchemaCacheStats {
    const total = this.stats.hits + this.stats.misses
    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: total > 0 ? this.stats.hits / total : 0,
      schemaCount: this.schemas.size,
      prefixCount: this.prefixCache.size,
    }
  }
}

export const globalSchemaCache = new SchemaCache()
