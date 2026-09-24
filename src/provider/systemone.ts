import { Hono } from "hono"
import type { Registry } from "../core/registry.js"
import { errorResponse } from "./errors.js"
import { s1Router } from "../s1/adapters/router.js"
import { globalSchemaCache } from "../s1/schema-cache.js"
import type {
  SystemOneRequest,
  DecideRequest,
  DecideResponse,
  ScoreRequest,
  ScoreResponse,
  S1Question,
  ChoiceQuestion,
  ScoreQuestion,
  NoulQuestion,
  ChoiceAnswer,
  ScoreAnswer,
  NoulAnswer,
} from "../s1/types.js"

export function createSystemOneRoutes(registry: Registry): Hono {
  const app = new Hono()

  // -------------------------------------------------------------------------
  // POST /v1/systemone - Full TypeSafe SDK Wire Protocol
  // -------------------------------------------------------------------------
  app.post("/v1/systemone", async (c) => {
    let body: SystemOneRequest
    try {
      body = (await c.req.json()) as SystemOneRequest
    } catch {
      return errorResponse(c, 400, "Invalid JSON payload in request body", "invalid_request_error", "malformed_json")
    }

    if (body.state === undefined || body.state === null) {
      return errorResponse(c, 400, "state field is required", "invalid_request_error", "missing_required_field")
    }

    // Resolve questions / schema
    let questions = body.questions
    if (!questions || questions.length === 0) {
      if (body.schema) {
        const compiled = globalSchemaCache.getOrCompile(body.schema)
        if (!compiled) {
          return errorResponse(
            c,
            400,
            `Schema not found: ${typeof body.schema === "string" ? body.schema : body.schema.id}`,
            "invalid_request_error",
            "schema_not_found"
          )
        }
        questions = compiled.questions
      } else {
        return errorResponse(
          c,
          400,
          "Either questions array or schema must be provided",
          "invalid_request_error",
          "missing_questions_or_schema"
        )
      }
    }

    // Validate individual question shapes
    for (const q of questions) {
      if (!q || !q.id || !q.prompt || !q.type) {
        return errorResponse(
          c,
          400,
          `Invalid question format for question id=${q?.id ?? "unknown"}. Must have id, prompt, and type`,
          "invalid_request_error",
          "invalid_question_format"
        )
      }
      if (q.type === "choice") {
        const cq = q as ChoiceQuestion
        if (!Array.isArray(cq.options) || cq.options.length < 2 || cq.options.length > 255) {
          return errorResponse(
            c,
            400,
            `Choice question '${q.id}' must have between 2 and 255 options`,
            "invalid_request_error",
            "invalid_options_count"
          )
        }
      } else if (q.type === "score") {
        const sq = q as ScoreQuestion
        const min = sq.min ?? 1
        const max = sq.max ?? 5
        const levelCount = sq.levels ? sq.levels.length : max - min + 1
        if (levelCount < 2 || levelCount > 10) {
          return errorResponse(
            c,
            400,
            `Score question '${q.id}' must have between 2 and 10 levels (got ${levelCount})`,
            "invalid_request_error",
            "invalid_score_levels"
          )
        }
      }
    }

    // Resolve model if requested
    const modelRecord = body.model ? (registry.get(body.model) || undefined) : undefined

    try {
      const response = await s1Router.evaluate(
        {
          ...body,
          questions,
        },
        modelRecord
      )
      return c.json(response)
    } catch (err) {
      return errorResponse(
        c,
        500,
        `S1 evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
        "server_error",
        "s1_evaluation_error"
      )
    }
  })

  // -------------------------------------------------------------------------
  // POST /decide - Convenience Endpoint for Choice and Binary Decisions
  // -------------------------------------------------------------------------
  app.post("/decide", async (c) => {
    let body: DecideRequest
    try {
      body = (await c.req.json()) as DecideRequest
    } catch {
      return errorResponse(c, 400, "Invalid JSON payload in request body", "invalid_request_error", "malformed_json")
    }

    if (body.state === undefined || body.state === null) {
      return errorResponse(c, 400, "state field is required", "invalid_request_error", "missing_required_field")
    }
    if (!body.question) {
      return errorResponse(c, 400, "question field is required", "invalid_request_error", "missing_required_field")
    }

    let q: S1Question
    if (typeof body.question === "string") {
      if (Array.isArray(body.options) && body.options.length >= 2) {
        q = {
          id: "decision",
          type: "choice",
          prompt: body.question,
          options: body.options,
          rubric: body.rubric,
        }
      } else {
        q = {
          id: "decision",
          type: "noul",
          prompt: body.question,
          rubric: body.rubric,
        }
      }
    } else {
      q = body.question as S1Question
    }

    const modelRecord = body.model ? (registry.get(body.model) || undefined) : undefined

    try {
      const s1Res = await s1Router.evaluate(
        {
          state: body.state,
          questions: [q],
          model: body.model,
          adapter: body.adapter,
        },
        modelRecord
      )

      const ans = s1Res.answers[q.id]
      if (!ans) {
        return errorResponse(c, 500, "No answer generated for decision", "server_error", "missing_answer")
      }

      if (ans.type === "choice") {
        const ca = ans as ChoiceAnswer
        const decideResponse: DecideResponse = {
          decision: ca.value,
          confidence: ca.confidence,
          probabilities: ca.probabilities,
          answer: ca,
          latency_ms: s1Res.usage.latency_ms,
        }
        return c.json(decideResponse)
      } else {
        const na = ans as NoulAnswer
        const decideResponse: DecideResponse = {
          decision: na.value,
          confidence: na.confidence,
          probabilities: na.probability,
          answer: na,
          latency_ms: s1Res.usage.latency_ms,
        }
        return c.json(decideResponse)
      }
    } catch (err) {
      return errorResponse(
        c,
        500,
        `Decide evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
        "server_error",
        "decide_evaluation_error"
      )
    }
  })

  // -------------------------------------------------------------------------
  // POST /score - Convenience Endpoint for Score Evaluation
  // -------------------------------------------------------------------------
  app.post("/score", async (c) => {
    let body: ScoreRequest
    try {
      body = (await c.req.json()) as ScoreRequest
    } catch {
      return errorResponse(c, 400, "Invalid JSON payload in request body", "invalid_request_error", "malformed_json")
    }

    if (body.state === undefined || body.state === null) {
      return errorResponse(c, 400, "state field is required", "invalid_request_error", "missing_required_field")
    }

    const min = body.min ?? 1
    const max = body.max ?? 5
    const prompt = typeof body.question === "string" ? body.question : body.question?.prompt ?? "Rate the quality of the input state"

    const q: ScoreQuestion = {
      id: "scoring",
      type: "score",
      prompt,
      min,
      max,
      levels: body.levels,
      rubric: body.rubric,
    }

    const modelRecord = body.model ? (registry.get(body.model) || undefined) : undefined

    try {
      const s1Res = await s1Router.evaluate(
        {
          state: body.state,
          questions: [q],
          model: body.model,
          adapter: body.adapter,
        },
        modelRecord
      )

      const ans = s1Res.answers[q.id] as ScoreAnswer
      if (!ans || ans.type !== "score") {
        return errorResponse(c, 500, "No score answer generated", "server_error", "missing_score_answer")
      }

      const scoreResponse: ScoreResponse = {
        expected_score: ans.expected_score,
        value: ans.value,
        confidence: ans.confidence,
        distribution: ans.probabilities,
        answer: ans,
        latency_ms: s1Res.usage.latency_ms,
      }
      return c.json(scoreResponse)
    } catch (err) {
      return errorResponse(
        c,
        500,
        `Score evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
        "server_error",
        "score_evaluation_error"
      )
    }
  })

  return app
}
