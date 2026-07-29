# Homestead Provider API Specification

**Version**: 0.1.0  
**Status**: Draft  
**Protocol**: OpenAI-compatible (HTTP REST, JSON)  
**Server**: Extends the existing Hono app at `src/ui/server.ts` — routes mounted at `/v1/*` on port `:3030`  
**Last Updated**: 2026-07-29

---

## 1. Protocol Decision

**Decision**: OpenAI-compatible HTTP API (`/v1/chat/completions`, `/v1/completions`, `/v1/models`).

**Rationale**:
- Both existing engines (Ollama, llama.cpp) already serve OpenAI-compatible `/v1` endpoints — Homestead proxies them, eliminating adapter code.
- Pi and Opencode natively support OpenAI-compatible provider configuration — no custom client code required.
- The broader agentic ecosystem (OpenAI SDK, LangChain, LlamaIndex, Vercel AI SDK) all speak this protocol.
- A custom Homestead protocol would add integration friction with zero benefit, since the underlying engines already speak standard formats.

**Rejected alternatives**:
- *LM Studio protocol*: Not widely adopted outside LM Studio; adds no advantage over OpenAI-compatible.
- *Custom Homestead protocol*: Would require every consumer to write a custom adapter — defeats the purpose of making local models a drop-in replacement for cloud providers.

---

## 2. Architecture

### 2.1 Provider Proxy Pattern

The provider server is a **transparent proxy** that sits between the client (Pi, Opencode) and the engine (Ollama, llama.cpp):

```
Client (Pi/Opencode)
    │
    ▼
Homestead Provider API (port :3030, /v1/*)
    │
    ├── GET  /v1/models      → Registry (SQLite)
    ├── POST /v1/chat/completions
    │       └── Auto-serve → Engine Manager → Ollama / llama.cpp
    │               │
    │               └── Proxy request to engine's /v1 endpoint
    │                   (streaming passthrough via SSE)
    └── GET  /v1/health      → inline health check
```

### 2.2 Server Integration

The provider routes share the **same Hono app** as the existing UI/dashboard server (`src/ui/server.ts`). No new port, daemon, or process — the provider API is available at `http://localhost:3030/v1/*` when the dashboard is running.

**CLI entry point**: Extended `homestead ui` command (no new subcommand required).

### 2.3 Auto-Serve on First Inference

**Decision**: Auto-serve. When a `POST /v1/chat/completions` or `POST /v1/completions` request arrives for a model that is not currently serving, the provider server automatically selects and starts the appropriate engine (via `EngineManager.selectEngine()` + `engine.serve()`), then proxies the request.

**Sequence**:

1. Parse `model` from request body
2. `Registry.get(modelName)` → find model in SQLite database
3. If `model.status !== 'serving'`:
   a. `EngineManager.selectEngine(model)` → get adapter
   b. `engine.serve(model, port)` → start engine subprocess
   c. `Registry.updateStatus(model.id, 'serving')`
   d. Update `Registry.get()` to return model with updated status
4. Proxy the request to `engine.endpoint` (e.g. `http://127.0.0.1:8080/v1/chat/completions`)
5. Return engine response to client (passthrough for non-streaming, SSE passthrough for streaming)

**Thread safety**: Only one serve operation per model at a time. Use a per-model lock or deduplicate via `runningProcesses` map (already handles this — `engine.serve()` returns existing process if already running).

**Failure**: If auto-serve fails, return 503 with OpenAI-format error body.

---

## 3. API Endpoints

### 3.1 `GET /v1/models`

OpenAI-compatible model listing. Returns all **servable** models (excludes vocab-only, cloud-only, and incomplete models).

**Response**:

```json
{
  "object": "list",
  "data": [
    {
      "id": "qwen2.5-7b-Q4_K_M",
      "object": "model",
      "created": 1720000000,
      "owned_by": "homestead",
      "homestead_metadata": {
        "source": "gguf-file",
        "format": "gguf",
        "quantization": "Q4_K_M",
        "size_bytes": 4294967296,
        "engine": "llama.cpp",
        "status": "discovered",
        "context_length": 32768,
        "parameter_count": "7B"
      }
    }
  ]
}
```

**Filtering rules** (only returns models where all are true):
- `status !== 'incomplete'`
- `tags` array does NOT contain `"vocab"` or `"cloud"`
- (Implicit: all models returned by `Registry.list()` that pass the above checks)

**Metadata** (`homestead_metadata`):
| Field | Source | Always present? |
|---|---|---|
| `source` | `ModelRecord.source` | Yes |
| `format` | `ModelRecord.format` | Yes |
| `quantization` | `ModelRecord.quantization` | If available |
| `size_bytes` | `ModelRecord.sizeBytes` | Yes |
| `engine` | `ModelRecord.engine` | If available (auto-detect otherwise) |
| `status` | `ModelRecord.status` | Yes |
| `context_length` | Parsed from GGUF metadata KV (story-303) | If available |
| `parameter_count` | Parsed from name or GGUF metadata (story-303) | If available |

Fields marked "story-303" can return `null` until metadata enrichment is implemented.

### 3.2 `GET /v1/models/:id`

OpenAI-compatible single model detail.

**Response**:

```json
{
  "id": "qwen2.5-7b-Q4_K_M",
  "object": "model",
  "created": 1720000000,
  "owned_by": "homestead",
  "homestead_metadata": { ... }
}
```

Returns 404 if model not found or not servable (same filtering as list).

### 3.3 `POST /v1/chat/completions`

OpenAI-compatible chat completions.

**Request**:

```json
{
  "model": "qwen2.5-7b-Q4_K_M",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "What is the capital of France?" }
  ],
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 2048
}
```

**Request fields** (OpenAI standard — passed through to engine):
- `model` (string, required) — Model name or ID from the registry
- `messages` (array, required) — Chat messages with `role` and `content`
- `stream` (boolean, optional, default: false)
- `temperature` (number, optional)
- `max_tokens` (integer, optional)
- `top_p` (number, optional)
- `stop` (string | array, optional)
- `frequency_penalty`, `presence_penalty` (number, optional)

**Non-standard additions**:
- `X-Homestead-Client` header (see §4.1) — for agent identification

**Non-streaming response** (OpenAI-compatible):

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1720000000,
  "model": "qwen2.5-7b-Q4_K_M",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The capital of France is Paris."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 25,
    "completion_tokens": 8,
    "total_tokens": 33
  }
}
```

**Streaming response** (OpenAI SSE format):

When `stream: true`, respond with `Content-Type: text/event-stream` and emit SSE frames:

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1720000000,"model":"qwen2.5-7b-Q4_K_M","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1720000000,"model":"qwen2.5-7b-Q4_K_M","choices":[{"index":0,"delta":{"content":"The"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1720000000,"model":"qwen2.5-7b-Q4_K_M","choices":[{"index":0,"delta":{"content":" capital"},"finish_reason":null}]}

...

data: [DONE]
```

**Implementation**: Proxy SSE frames directly from the engine's streaming response. Do NOT buffer or transform — forward chunks as-is. The engine (Ollama/llama.cpp) already emits OpenAI-compatible SSE chunks.

**Model routing logic** (applied before proxying):

```
model_name = body.model
model = registry.get(model_name)
if not model:
    return 404 error

if model has tag "vocab":
    return 400 error (cannot serve vocabulary-only file)
if model has tag "cloud":
    return 400 error (cloud-only, not local)
if model has tag "incomplete":
    return 400 error (download incomplete)

if model.status != "serving":
    engine = engineManager.selectEngine(model)
    if not engine:
        return 503 error (no compatible engine)
    proc = await engine.serve(model, auto_port)
    registry.updateStatus(model.id, "serving")
    // now proxy to proc.endpoint
else:
    proc = findRunningProcess(model.id)

proxy_request to proc.endpoint + /chat/completions
```

**Auto port assignment**: Use port `8080` (llama.cpp default) or increment from `8080` if busy. Ollama uses its own port (`11434` by default).

### 3.4 `POST /v1/completions`

OpenAI-compatible text completions. Same structure as `/v1/chat/completions` but for legacy completion models.

**Request**:

```json
{
  "model": "qwen2.5-7b-Q4_K_M",
  "prompt": "The capital of France is",
  "stream": false,
  "max_tokens": 50
}
```

**Response**: Standard OpenAI completions response format.

**Implementation**: Proxy to engine's corresponding endpoint with same passthrough/SSE logic.

### 3.5 `GET /v1/health`

Lightweight health check for provider availability (used by story-306 fallback).

**Response**:

```json
{
  "status": "ok",
  "version": "0.0.2",
  "models_available": 14,
  "models_serving": 2,
  "uptime_sec": 3600
}
```

**Implementation**: Inline check — no proxy needed. Read from `Registry.stats()` and process start time.

---

## 4. Caller Identification

### 4.1 `X-Homestead-Client` Header

**Decision**: Identifying the caller via an `X-Homestead-Client` request header.

**Format**: `X-Homestead-Client: <client-name>/<version>`

Examples:
- `X-Homestead-Client: pi/1.0.0`
- `X-Homestead-Client: opencode/0.1.0`
- `X-Homestead-Client: openai-sdk/1.54.0`

This header is **optional** — if absent, the caller is recorded as `"unknown"`. It is consumed by the provider server for:
- Observability event tagging (story-309 agent-event vocabulary)
- Per-agent usage tracking

**Future consideration**: If the name/version reliably identifies the calling agent, request volume per agent can be attributed in the observability DB without any client-side extension work.

---

## 5. Error Handling

**Decision**: OpenAI-compatible error format for all error responses.

### 5.1 Error Response Shape

```json
{
  "error": {
    "message": "Model not found: nonexistent-model",
    "type": "invalid_request_error",
    "code": "model_not_found"
  }
}
```

### 5.2 Error Codes

| HTTP | `type` | `code` | Cause |
|------|--------|--------|-------|
| 400 | `invalid_request_error` | `model_not_found` | Requested model is not in registry |
| 400 | `invalid_request_error` | `model_not_servable` | Model exists but has `vocab`/`cloud`/`incomplete` tag |
| 400 | `invalid_request_error` | `invalid_messages` | `messages` field missing or malformed |
| 503 | `server_error` | `engine_unavailable` | No compatible engine found for model |
| 503 | `server_error` | `serve_failed` | Engine failed to start model |
| 500 | `server_error` | `proxy_error` | Engine responded with error during inference |
| 504 | `server_error` | `upstream_timeout` | Engine did not respond in time |

### 5.3 Fallback Behavior (for story-306)

When Homestead is offline or returns 5xx:
- **Pi/Opencode should** fall back to their next configured provider (Gemini, OpenRouter, etc.)
- **Homestead should** return clear 503 with `engine_unavailable` or `serve_failed` so the client knows the proxy is reachable but the model isn't.
- The `/v1/health` endpoint should be checked by clients before sending inference requests (optional, recommended).

---

## 6. Design Decisions Register

| # | Question | Decision | Date |
|---|----------|----------|------|
| 1 | Protocol: OpenAI, LM Studio, or custom? | **OpenAI-compatible** (all engines speak it, all agents consume it) | 2026-07-29 |
| 2 | Server lifecycle: standalone vs. CLI-managed? | **Same Hono app as UI** — `/v1/*` routes on port :3030, no separate daemon | 2026-07-29 |
| 3 | Authentication? | **None** (local-only). Enterprise auth is a future concern, not v0.1. | 2026-07-29 |
| 4 | Model selection: all vs. allowlist? | **All servable** — models without `vocab`/`cloud`/`incomplete` tags are listed and can be auto-served | 2026-07-29 |
| 5 | Telemetry: log inference to obs DB? | **Yes** — reuse existing `globalEmitter` pipeline for request/response/error events | 2026-07-29 |
| 6 | When to serve a model? | **Auto-serve on first inference request** — no pre-serve step required | 2026-07-29 |
| 7 | Caller identification mechanism? | **`X-Homestead-Client` header** — optional, format `<name>/<version>` | 2026-07-29 |
| 8 | Which models exposed in /v1/models? | **Servable only** — excludes vocab, cloud, incomplete | 2026-07-29 |
| 9 | Streaming format? | **OpenAI SSE** — passthrough from engine, no transformation | 2026-07-29 |
| 10 | Error format? | **OpenAI error schema** — `{ error: { message, type, code } }` | 2026-07-29 |

---

## 7. Implementation Guidance for Story-302

### 7.1 Files to Create/Modify

| Action | File | Purpose |
|--------|------|---------|
| **Create** | `src/src/provider/homestead.ts` | Provider Hono app — all `/v1/*` route handlers |
| **Modify** | `src/src/ui/server.ts` | Mount provider routes: `app.route("/v1", providerApp)` |
| **Create** | `src/src/provider/models.ts` | `/v1/models` route |
| **Create** | `src/src/provider/chat.ts` | `/v1/chat/completions` route |
| **Create** | `src/src/provider/completions.ts` | `/v1/completions` route |
| **Create** | `src/src/provider/health.ts` | `/v1/health` route |
| **Create** | `src/src/provider/proxy.ts` | Proxy utility: forward request to engine endpoint |
| **Create** | `src/src/provider/errors.ts` | Error response helpers (OpenAI format) |

### 7.2 Key Implementation Details

- **Request validation**: Use `zod` (already a dependency) to validate incoming request bodies against the OpenAI schema.
- **Engine endpoint lookup**: `From RunningProcesses` map (`engineManager.getRunningProcesses()`), or from `ServingProcess.endpoint` returned by `engine.serve()`. For Ollama, the endpoint is always `http://127.0.0.1:11434/v1` (or `OLLAMA_HOST/v1`). For llama.cpp, the port is assigned at serve time.
- **Proxy implementation**: Use `fetch()` to forward requests to the engine. For streaming, use `Response` with `ReadableStream` that pipes the engine's SSE response through.
- **Concurrent requests**: Hono handles concurrent requests natively. The auto-serve path must guard against race conditions (two concurrent requests for the same unserved model). Use a per-model `Promise` cache or mutex.
- **Port management**: When auto-serving to llama.cpp, start at `8080` and increment if busy. Track assigned ports to avoid conflicts.

### 7.3 Integration Points

- **`Registry`** — model lookup, status updates, filtering
- **`EngineManager`** — engine selection, `serve()`, `getRunningProcesses()`
- **`globalEmitter`** — observability event emission (request, response, error)
- **`ServingProcess`** — endpoint URL for proxy routing

---

## 8. Open Questions (Deferred)

These are tracked for post-v0.1 consideration:

- Should the provider server support **TLS** for local-only use? (Unlikely — add if needed)
- Should we support **multiple concurrent model serves** for load balancing across requesters? (Out of scope — one model at a time per engine instance)
- Should `/v1/models` support OpenAI's `?owner=<owner>` query parameter? (Defer until a consumer requests it)
