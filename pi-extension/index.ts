import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const BASE_URL = "http://localhost:3030/v1"
const DEFAULT_CONTEXT_WINDOW = 8192
const DEFAULT_MAX_TOKENS = 4096

interface HomesteadModel {
  id: string
  object: string
  created: number
  owned_by: string
  homestead_metadata: {
    source: string
    format: string
    quantization: string | null
    size_bytes: number
    engine: string | null
    status: string
    context_length: number | null
    parameter_count: string | null
    architecture: string | null
    file_type: number | null
  }
}

async function fetchModels(): Promise<HomesteadModel[]> {
  try {
    const res = await fetch(`${BASE_URL}/models`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return []
    const { data } = await res.json() as { data: HomesteadModel[] }
    return data ?? []
  } catch {
    return []
  }
}

function toProviderModels(models: HomesteadModel[]) {
  return models.map((m) => {
    const hm = m.homestead_metadata
    return {
      id: m.id,
      name: m.id,
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: hm.context_length ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    }
  })
}

export default async function (pi: ExtensionAPI) {
  const models = await fetchModels()
  if (models.length > 0) {
    pi.registerProvider("homestead", {
      name: "Homestead (local)",
      baseUrl: BASE_URL,
      api: "openai-completions",
      apiKey: "homestead",
      headers: { "X-Homestead-Client": "pi" },
      models: toProviderModels(models),
    })
  }

  pi.on("session_start", async () => {
    const refreshed = await fetchModels()
    if (refreshed.length > 0) {
      pi.registerProvider("homestead", {
        name: "Homestead (local)",
        baseUrl: BASE_URL,
        api: "openai-completions",
        apiKey: "homestead",
        headers: { "X-Homestead-Client": "pi" },
        models: toProviderModels(refreshed),
      })
    }
  })
}
