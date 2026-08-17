import { randomUUID } from "node:crypto"
import { globalEmitter } from "../observability/emitter.js"

export interface ProxyContext {
  sessionId?: string
  modelId?: string
  modelName?: string
  engineKind?: string
}

export function resolveProxyUrl(endpoint: string, path: string): string {
  const cleanEndpoint = endpoint.replace(/\/+$/, "")
  const cleanPath = path.startsWith("/") ? path : `/${path}`

  if (cleanEndpoint.endsWith("/v1") && cleanPath.startsWith("/v1/")) {
    return `${cleanEndpoint}${cleanPath.slice(3)}`
  }
  if (cleanEndpoint.endsWith("/v1") && cleanPath === "/v1") {
    return cleanEndpoint
  }
  return `${cleanEndpoint}${cleanPath}`
}

export async function proxyToEngine(
  endpoint: string,
  path: string,
  body: unknown,
  customHeaders: Record<string, string> = {},
  ctx: ProxyContext = {}
): Promise<Response> {
  const url = resolveProxyUrl(endpoint, path)
  const isStream = typeof body === "object" && body !== null && (body as Record<string, unknown>).stream === true
  const requestId = randomUUID()
  const t0 = Date.now()

  const modelId = ctx.modelId || (typeof body === "object" && body !== null ? (body as any).model : "") || "unknown"
  const modelName = ctx.modelName || modelId
  const engineKind = ctx.engineKind || "homestead"

  let sessionId = ctx.sessionId
  if (!sessionId) {
    const active = globalEmitter.getDb().getActiveSessionByModel(modelId)
    sessionId = active ? active.session_id : `session-${modelId}-${Date.now()}`
  }

  let inputTokens = 0
  if (typeof body === "object" && body !== null) {
    const b = body as any
    if (typeof b.prompt === "string") {
      inputTokens = Math.ceil(b.prompt.length / 4)
    } else if (Array.isArray(b.messages)) {
      const charCount = b.messages.reduce((acc: number, m: any) => acc + (typeof m.content === "string" ? m.content.length : 0), 0)
      inputTokens = Math.ceil(charCount / 4)
    }
  }

  globalEmitter.request(sessionId, modelId, modelName, engineKind, {
    request_id: requestId,
    method: "POST",
    path,
    model: modelName,
    input_tokens: inputTokens,
    max_tokens: typeof body === "object" && body !== null ? (body as any).max_tokens : undefined,
    temperature: typeof body === "object" && body !== null ? (body as any).temperature : undefined,
  })

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...customHeaders,
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text()
      globalEmitter.error(sessionId, modelId, modelName, engineKind, {
        request_id: requestId,
        message: `HTTP ${response.status}: ${text}`,
        code: `http_${response.status}`,
      })
      return new Response(text, { status: response.status, headers: { "Content-Type": "application/json" } })
    }

    if (isStream && response.body) {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let outputTokens = 0
      let usageExtracted = false

      const processLine = (line: string) => {
        const trimmed = line.trim()
        if (!trimmed.startsWith("data:")) return
        const payload = trimmed.slice(5).trim()
        if (payload === "[DONE]") return

        try {
          const parsed = JSON.parse(payload)
          if (parsed.usage && typeof parsed.usage.completion_tokens === "number") {
            outputTokens = parsed.usage.completion_tokens
            if (typeof parsed.usage.prompt_tokens === "number") {
              inputTokens = parsed.usage.prompt_tokens
            }
            usageExtracted = true
          } else if (!usageExtracted && parsed.choices?.[0]?.delta?.content) {
            outputTokens += 1
          }
        } catch {}
      }

      const stream = new ReadableStream({
        async start(controller) {
          let buffer = ""
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) {
                if (buffer.trim()) {
                  processLine(buffer)
                }
                const latencyMs = Date.now() - t0
                globalEmitter.response(sessionId!, modelId, modelName, engineKind, {
                  request_id: requestId,
                  output_tokens: outputTokens,
                  input_tokens: inputTokens,
                  total_tokens: inputTokens + outputTokens,
                  latency_ms: latencyMs,
                  status: response.status,
                })
                controller.close()
                break
              }

              controller.enqueue(value)
              buffer += decoder.decode(value, { stream: true })
              const lines = buffer.split("\n")
              buffer = lines.pop() ?? ""

              for (const line of lines) {
                processLine(line)
              }
            }
          } catch (err) {
            globalEmitter.error(sessionId!, modelId, modelName, engineKind, {
              request_id: requestId,
              message: String(err),
              code: "stream_error",
            })
            controller.error(err)
          }
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

    const data = await response.json() as any
    const latencyMs = Date.now() - t0
    const outTokens = data?.usage?.completion_tokens ?? (typeof data?.choices?.[0]?.text === "string" ? Math.ceil(data.choices[0].text.length / 4) : typeof data?.choices?.[0]?.message?.content === "string" ? Math.ceil(data.choices[0].message.content.length / 4) : 0)
    const inTokens = data?.usage?.prompt_tokens ?? inputTokens

    globalEmitter.response(sessionId, modelId, modelName, engineKind, {
      request_id: requestId,
      output_tokens: outTokens,
      input_tokens: inTokens,
      total_tokens: inTokens + outTokens,
      latency_ms: latencyMs,
      status: response.status,
    })

    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" },
    })
  } catch (err) {
    globalEmitter.error(sessionId, modelId, modelName, engineKind, {
      request_id: requestId,
      message: `Failed to proxy request to ${url}: ${err instanceof Error ? err.message : String(err)}`,
      code: "engine_unreachable",
    })
    return new Response(
      JSON.stringify({
        error: {
          message: `Failed to proxy request to ${url}: ${err instanceof Error ? err.message : String(err)}`,
          type: "proxy_error",
          code: "engine_unreachable",
        },
      }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    )
  }
}
