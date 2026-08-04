import type { ModelRecord } from "../types.js"

interface OllamaModel {
  name: string
  modified_at: string
  size: number
  digest: string
  details?: {
    format: string
    family: string
    families: string[]
    parameter_size: string
    quantization_level: string
  }
}

interface OllamaListResponse {
  models: OllamaModel[]
}

export async function scanOllama(): Promise<ModelRecord[]> {
  const endpoint = process.env.OLLAMA_HOST || "http://127.0.0.1:11434"
  const models: ModelRecord[] = []

  try {
    const res = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return models

    const data = (await res.json()) as OllamaListResponse
    if (!data.models) return models

    for (const m of data.models) {
      const isCloud = m.size < 1024 || m.name.includes(":cloud")
      const quant = m.details?.quantization_level || null
      const now = new Date().toISOString()

      const tags: string[] = isCloud ? ["cloud"] : ["weights"]

      models.push({
        id: `ollama-${m.name.replace(/[:/]/g, "-")}`,
        name: m.name,
        source: "ollama",
        sourceId: m.digest,
        path: `${endpoint}/v1`,
        sizeBytes: m.size,
        format: "gguf",
        quantization: quant,
        engine: "ollama",
        status: isCloud ? "discovered" : "discovered",
        metadata: {
          digest: m.digest,
          parameterSize: m.details?.parameter_size || null,
          family: m.details?.family || null,
          isCloud,
          tags,
          apiEndpoint: endpoint,
          serverRunning: true,
        },
        discoveredAt: now,
        updatedAt: now,
      })
    }
  } catch {
    return models
  }

  return models
}
