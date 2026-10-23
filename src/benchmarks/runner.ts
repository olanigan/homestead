import { existsSync, statSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { createServer, type AddressInfo } from "node:net"
import { LlamaCppAdapter } from "../engines/index.js"
import { ObsDb } from "../observability/db.js"
import type { ModelRecord, ServeOptions } from "../types.js"
import type { BenchmarkRecord } from "../observability/types.js"

export interface BenchmarkOptions {
  targetFile?: string
  modelPath?: string
  suites?: Array<{
    suite: string
    label: string
    serveOpts: ServeOptions
    prompt: string
    maxTokens: number
  }>
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.on("error", rej)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => res(port))
    })
  })
}

async function waitForHealth(port: number, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_500) })
      if (res.status === 200) return
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`Server failed to become healthy on port ${port} within ${timeoutMs}ms`)
}

interface RunMetrics {
  ttftMs: number
  promptTps: number
  completionTps: number
  totalMs: number
  inputTokens: number
  outputTokens: number
}

async function executeCompletion(
  port: number,
  prompt: string,
  maxTokens: number
): Promise<RunMetrics> {
  const startedAt = Date.now()
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "homestead",
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature: 0,
      stream: true,
      stream_options: { include_usage: true },
    }),
  })

  if (!res.ok || !res.body) {
    throw new Error(`HTTP error ${res.status}: ${await res.text()}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let firstTokenTs = 0
  let outputTokens = 0
  let promptTokens = Math.max(1, Math.round(prompt.length / 4)) // fallback approx

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value, { stream: true })
    if (!firstTokenTs) {
      firstTokenTs = Date.now()
    }
    const lines = chunk.split("\n")
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue
      const dataStr = line.slice(6).trim()
      if (dataStr === "[DONE]") continue
      try {
        const parsed = JSON.parse(dataStr)
        if (parsed.choices?.[0]?.delta?.content) {
          outputTokens++
        }
        if (parsed.usage) {
          if (parsed.usage.prompt_tokens) promptTokens = parsed.usage.prompt_tokens
          if (parsed.usage.completion_tokens) outputTokens = parsed.usage.completion_tokens
        }
      } catch {}
    }
  }

  const totalMs = Date.now() - startedAt
  const ttftMs = firstTokenTs ? firstTokenTs - startedAt : totalMs
  const genMs = Math.max(1, totalMs - ttftMs)
  const promptTps = Number(((promptTokens / (ttftMs / 1000))).toFixed(1))
  const completionTps = Number(((outputTokens / (genMs / 1000))).toFixed(1))

  return {
    ttftMs,
    promptTps,
    completionTps,
    totalMs,
    inputTokens: promptTokens,
    outputTokens,
  }
}

export async function runBenchmarks(options?: BenchmarkOptions): Promise<BenchmarkRecord[]> {
  const db = new ObsDb()

  let model: ModelRecord | null = null
  let manifestServeOpts: ServeOptions | null = null

  if (options?.targetFile) {
    const target = resolve(options.targetFile)
    if (!existsSync(target)) {
      throw new Error(`Target file not found for benchmark: ${target}`)
    }
    if (target.endsWith(".yaml") || target.endsWith(".yml") || target.toLowerCase().includes("homesteadfile")) {
      const { parseHomesteadfile, homesteadfileToModelRecord, homesteadfileTuningToServeOptions } = await import("../core/homesteadfile.js")
      const spec = parseHomesteadfile(target)
      const basePath = dirname(target)
      model = homesteadfileToModelRecord(spec, basePath)
      if (spec.engine?.tuning) {
        manifestServeOpts = homesteadfileTuningToServeOptions(spec.engine.tuning)
      }
    } else {
      model = {
        id: "custom-bench-model",
        name: target.split("/").pop()?.replace(/\.\w+$/, "") || "CustomModel",
        source: "gguf-file",
        sourceId: target,
        path: target,
        sizeBytes: statSync(target).size,
        format: "gguf",
        quantization: null,
        engine: "llama.cpp",
        status: "discovered",
        metadata: { tags: ["weights"] },
        discoveredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
    }
  }

  if (!model) {
    const candidatePaths = [
      options?.modelPath,
      resolve(process.cwd(), ".ci/models/SmolLM2-135M-Instruct-Q3_K_M.gguf"),
      resolve(process.cwd(), "localai-harness/homestead/.ci/models/SmolLM2-135M-Instruct-Q3_K_M.gguf"),
      resolve(import.meta.dir, "../../.ci/models/SmolLM2-135M-Instruct-Q3_K_M.gguf"),
    ].filter(Boolean) as string[]

    const modelPath = candidatePaths.find((p) => existsSync(p))
    if (!modelPath) {
      throw new Error(`Benchmark model SmolLM2-135M-Instruct-Q3_K_M.gguf not found in candidate paths.`)
    }

    model = {
      id: "smollm2-135m-instruct",
      name: "SmolLM2-135M-Instruct-Q3_K_M",
      source: "gguf-file",
      sourceId: modelPath,
      path: modelPath,
      sizeBytes: statSync(modelPath).size,
      format: "gguf",
      quantization: "Q3_K_M",
      engine: "llama.cpp",
      status: "discovered",
      metadata: { tags: ["weights"], parameter_count: "135M" },
      discoveredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }

  console.log(`\n========================================================================`)
  console.log(`🚀 HOMESTEAD INFERENCE BENCHMARK RUNNER`)
  console.log(`Model: ${model.name} (${model.metadata?.parameter_count || model.format}, ${model.quantization || "unquantized"})`)
  console.log(`Path:  ${model.path}`)
  console.log(`DB:    ${process.env.HOMESTEAD_OBS_DB_PATH || "default SQLite obs.db"}`)
  if (manifestServeOpts) {
    console.log(`Tuning: ${JSON.stringify(manifestServeOpts)}`)
  }
  console.log(`========================================================================\n`)

  const testSuites: Array<{
    suite: string
    label: string
    serveOpts: ServeOptions
    prompt: string
    maxTokens: number
  }> = options?.suites ?? [
    ...(manifestServeOpts
      ? [
          {
            suite: "Homesteadfile Tuning Manifest",
            label: `Configured Knobs (${model.name})`,
            serveOpts: { ...manifestServeOpts },
            prompt: "Explain why quantum computing matters in two concise sentences.",
            maxTokens: 48,
          },
        ]
      : []),
    // ----------------------------------------------------
    // Set 1: Flash Attention & Context Scaling
    // ----------------------------------------------------
    {
      suite: "Flash Attention & Scaling",
      label: "Flash Attn ON (Short 64t)",
      serveOpts: { flashAttn: true, threads: 4 },
      prompt: "Explain why quantum computing matters in two concise sentences.",
      maxTokens: 48,
    },
    {
      suite: "Flash Attention & Scaling",
      label: "Flash Attn OFF (Short 64t)",
      serveOpts: { flashAttn: false, threads: 4 },
      prompt: "Explain why quantum computing matters in two concise sentences.",
      maxTokens: 48,
    },
    {
      suite: "Flash Attention & Scaling",
      label: "Flash Attn ON (Med 512t)",
      serveOpts: { flashAttn: true, threads: 4 },
      prompt: "Here is context: " + "The quick brown fox jumped over the lazy sleeping dog repeatedly through the dense forest. ".repeat(18) + "What animal jumped?",
      maxTokens: 48,
    },
    {
      suite: "Flash Attention & Scaling",
      label: "Flash Attn OFF (Med 512t)",
      serveOpts: { flashAttn: false, threads: 4 },
      prompt: "Here is context: " + "The quick brown fox jumped over the lazy sleeping dog repeatedly through the dense forest. ".repeat(18) + "What animal jumped?",
      maxTokens: 48,
    },

    // ----------------------------------------------------
    // Set 2: CPU Thread Saturation
    // ----------------------------------------------------
    {
      suite: "CPU Thread Scaling",
      label: "2 Threads",
      serveOpts: { threads: 2, flashAttn: true },
      prompt: "Write a short creative paragraph describing an autonomous spaceship entering an asteroid belt.",
      maxTokens: 100,
    },
    {
      suite: "CPU Thread Scaling",
      label: "4 Threads (Physical Cores)",
      serveOpts: { threads: 4, flashAttn: true },
      prompt: "Write a short creative paragraph describing an autonomous spaceship entering an autonomous asteroid belt.",
      maxTokens: 100,
    },
    {
      suite: "CPU Thread Scaling",
      label: "8 Threads (Max Logical Cores)",
      serveOpts: { threads: 8, flashAttn: true },
      prompt: "Write a short creative paragraph describing an autonomous spaceship entering an autonomous asteroid belt.",
      maxTokens: 100,
    },

    // ----------------------------------------------------
    // Set 3: Batching & Micro-Batching
    // ----------------------------------------------------
    {
      suite: "Ingestion Batching",
      label: "Batch 512 / uBatch 512",
      serveOpts: { batchSize: 512, ubatchSize: 512, flashAttn: true, threads: 4 },
      prompt: "Analyze the trade-offs between monolithic architectures and event-driven microservices across scalability, maintenance, and debugging complexity.",
      maxTokens: 64,
    },
    {
      suite: "Ingestion Batching",
      label: "Batch 1024 / uBatch 256",
      serveOpts: { batchSize: 1024, ubatchSize: 256, flashAttn: true, threads: 4 },
      prompt: "Analyze the trade-offs between monolithic architectures and event-driven microservices across scalability, maintenance, and debugging complexity.",
      maxTokens: 64,
    },
    {
      suite: "Ingestion Batching",
      label: "Batch 2048 / uBatch 512",
      serveOpts: { batchSize: 2048, ubatchSize: 512, flashAttn: true, threads: 4 },
      prompt: "Analyze the trade-offs between monolithic architectures and event-driven microservices across scalability, maintenance, and debugging complexity.",
      maxTokens: 64,
    },
  ]

  const records: BenchmarkRecord[] = []

  for (let i = 0; i < testSuites.length; i++) {
    const item = testSuites[i]!
    console.log(`[${i + 1}/${testSuites.length}] Running: ${item.suite} -> ${item.label}...`)

    const adapter = new LlamaCppAdapter()
    const port = await freePort()
    const sp = await adapter.serve(model, port, item.serveOpts)

    try {
      await waitForHealth(port)

      // Warmup ping
      try {
        await executeCompletion(port, "Hello", 4)
      } catch {}

      // Measured run
      const metrics = await executeCompletion(port, item.prompt, item.maxTokens)

      const record: BenchmarkRecord = {
        id: `bench-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        suite: item.suite,
        model_id: model.id,
        model_name: model.name,
        label: item.label,
        config: { ...item.serveOpts },
        workload: { promptLength: item.prompt.length, maxTokens: item.maxTokens },
        prompt_tokens: metrics.inputTokens,
        output_tokens: metrics.outputTokens,
        total_tokens: metrics.inputTokens + metrics.outputTokens,
        ttft_ms: metrics.ttftMs,
        prompt_tps: metrics.promptTps,
        completion_tps: metrics.completionTps,
        total_ms: metrics.totalMs,
        status: "completed",
        created_at: new Date().toISOString(),
      }

      db.insertBenchmark(record)
      records.push(record)

      console.log(`   ✓ TTFT: ${record.ttft_ms?.toFixed(1)}ms | Prefill: ${record.prompt_tps?.toFixed(1)} tok/s | Decode: ${record.completion_tps?.toFixed(1)} tok/s | Total: ${record.total_ms.toFixed(0)}ms`)
    } catch (err) {
      console.error(`   ✗ Run failed: ${err}`)
    } finally {
      await adapter.stop(sp)
      // Allow OS to release socket
      await new Promise((r) => setTimeout(r, 600))
    }
  }

  // Print Summary Table
  console.log(`\n========================================================================`)
  console.log(`📊 BENCHMARK RESULTS SUMMARY (Saved in SQLite)`)
  console.log(`========================================================================`)
  console.log(`${"SUITE".padEnd(28)} ${"LABEL".padEnd(30)} ${"TTFT".padEnd(10)} ${"PREFILL".padEnd(14)} ${"DECODE"}`)
  console.log(`${"─".repeat(28)} ${"─".repeat(30)} ${"─".repeat(10)} ${"─".repeat(14)} ${"─".repeat(12)}`)
  for (const r of records) {
    console.log(
      `${r.suite.padEnd(28)} ${r.label.padEnd(30)} ${(r.ttft_ms ? `${r.ttft_ms.toFixed(1)}ms` : "—").padEnd(10)} ${(r.prompt_tps ? `${r.prompt_tps.toFixed(1)} tok/s` : "—").padEnd(14)} ${(r.completion_tps ? `${r.completion_tps.toFixed(1)} tok/s` : "—")}`
    )
  }
  console.log(`========================================================================\n`)

  return records
}

if (import.meta.main) {
  const targetFile = process.argv[2]
  runBenchmarks(targetFile ? { targetFile } : undefined)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Benchmark runner failed:", err)
      process.exit(1)
    })
}
