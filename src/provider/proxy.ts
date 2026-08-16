import { randomUUID } from "node:crypto"
import { globalEmitter } from "../observability/emitter.js"
import type { RequestPayload, ResponsePayload } from "../observability/types.js"

export interface ProxyToEngineOptions {
  endpoint: string
  path: string
  body: unknown
  modelId: string
  modelName: string
  engineKind: string
  clientHeader?: string
}

// OpenAI-compatible engines echo token counts back in a top-level `usage`
// object for non-streaming responses and in the final SSE chunk for streaming.
interface UsageLike {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

function extractUsage(data: unknown): UsageLike | undefined {
  if (typeof data === "object" && data !== null && "usage" in data) {
    const usage = (data as { usage?: UsageLike }).usage
    if (usage && typeof usage === "object") return usage
  }
  return undefined
}

function extractStreamUsage(accumulated: string): UsageLike | undefined {
  const idx = accumulated.lastIndexOf('"usage"')
  if (idx === -1) return undefined
  const open = accumulated.indexOf("{", idx)
  if (open === -1) return undefined
  const close = accumulated.indexOf("}", open)
  if (close === -1) return undefined
  try {
    return JSON.parse(accumulated.slice(open, close + 1)) as UsageLike
  } catch {
    return undefined
  }
}

export async function proxyToEngine(opts: ProxyToEngineOptions): Promise<Response> {
  const { endpoint, path, body, modelId, modelName, engineKind, clientHeader } = opts
  const url = `${endpoint}${path}`
  const isStream = typeof body === "object" && body !== null && (body as Record<string, unknown>).stream === true
  const requestId = randomUUID()
  const startedAt = Date.now()

  const activeSession = globalEmitter.getDb().getActiveSessionByModel(modelId)
  const sessionId = activeSession?.session_id ?? `${engineKind}-${modelId}-${Date.now()}`

  const requestPayload: RequestPayload = {
    request_id: requestId,
    method: "POST",
    path,
    model: modelName,
    client: clientHeader ?? "unknown",
  }
  globalEmitter.request(sessionId, modelId, modelName, engineKind, requestPayload)

  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (clientHeader) headers["X-Homestead-Client"] = clientHeader

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })

  const emitResponse = (payload: ResponsePayload): void => {
    globalEmitter.response(sessionId, modelId, modelName, engineKind, {
      ...payload,
      client: clientHeader ?? "unknown",
    })
  }

  if (!response.ok) {
    const text = await response.text()
    emitResponse({ request_id: requestId, latency_ms: Date.now() - startedAt, status: response.status })
    globalEmitter.error(sessionId, modelId, modelName, engineKind, {
      request_id: requestId,
      message: text.slice(0, 500),
      code: `engine_http_${response.status}`,
    })
    return new Response(text, { status: response.status, headers: { "Content-Type": "application/json" } })
  }

  if (isStream) {
    // Forward SSE frames as-is (per src/provider/API.md: do NOT buffer or
    // transform), but observe the tail long enough to pull a final `usage`
    // object, then emit the response event once the stream finishes.
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let tail = ""
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          const usage = extractStreamUsage(tail)
          emitResponse({
            request_id: requestId,
            latency_ms: Date.now() - startedAt,
            status: 200,
            input_tokens: usage?.prompt_tokens,
            output_tokens: usage?.completion_tokens,
            total_tokens: usage?.total_tokens,
          })
          return
        }
        tail += decoder.decode(value, { stream: true })
        if (tail.length > 16_384) tail = tail.slice(-16_384)
        controller.enqueue(value)
      },
      cancel() {
        emitResponse({ request_id: requestId, latency_ms: Date.now() - startedAt, status: 499 })
      },
    })
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })
  }

  const data = (await response.json()) as Record<string, unknown>
  const usage = extractUsage(data)
  emitResponse({
    request_id: requestId,
    latency_ms: Date.now() - startedAt,
    status: 200,
    input_tokens: usage?.prompt_tokens,
    output_tokens: usage?.completion_tokens,
    total_tokens: usage?.total_tokens,
  })
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  })
}
