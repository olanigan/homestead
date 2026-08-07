import { readdirSync, statSync, existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ModelRecord } from "../types.js"
import { readGgufHeader, readGgufMetadata } from "../core/gguf.js"

interface HfModelRef {
  org: string
  name: string
  path: string
  snapshots: string[]
  totalBytes: number
  isComplete: boolean
  detectedFormat: ModelRecord["format"]
  quantization: string | null
  fileCount: number
}

function walkDir(dir: string, maxDepth = 6): Array<{ name: string; size: number; path: string }> {
  if (!existsSync(dir) || maxDepth <= 0) return []
  try {
    const results: Array<{ name: string; size: number; path: string }> = []
    const entries = readdirSync(dir, { withFileTypes: true }) as Array<{ name: string; isFile(): boolean; isSymbolicLink(): boolean; isDirectory(): boolean }>
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        results.push(...walkDir(fullPath, maxDepth - 1))
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        try {
          const s = statSync(fullPath)
          results.push({ name: entry.name, size: s.size, path: fullPath })
        } catch {
          results.push({ name: entry.name, size: 0, path: fullPath })
        }
      }
    }
    return results
  } catch {
    return []
  }
}

function detectFormat(files: Array<{ name: string }>, org: string): ModelRecord["format"] {
  const names = files.map((f) => f.name.toLowerCase())

  if (names.some((n) => n.endsWith(".gguf"))) return "gguf"
  if (org.includes("mlx") || names.some((n) => n.includes("mlx") || n.endsWith(".mlx") || n.includes("mlx_model"))) return "mlx"
  if (names.some((n) => n.endsWith(".safetensors"))) return "safetensors"
  if (names.some((n) => n.endsWith(".pt") || n.endsWith(".pth"))) return "pt"
  if (names.some((n) => n.endsWith(".onnx"))) return "onnx"
  return "unknown"
}

function determineTags(ref: HfModelRef, ggufFiles: Array<{ path: string }>): string[] {
  const tags: string[] = []
  if (!ref.isComplete) {
    tags.push("incomplete")
    return tags
  }
  if (ref.detectedFormat === "unknown") {
    tags.push("unknown")
    return tags
  }
  if (ref.detectedFormat === "gguf") {
    const isVocab = ggufFiles.some((f) => {
      const h = readGgufHeader(f.path)
      return h !== null && h.tensorCount === 0
    })
    tags.push(isVocab ? "vocab" : "weights")
  } else {
    tags.push("weights")
  }
  return tags
}

function detectQuantGguf(files: Array<{ name: string }>): string | null {
  for (const f of files) {
    const match = f.name.match(/Q\d+_\w+|q\d+_\w+|fp16|f16|fp32|f32|BF16|bf16/i)
    if (match) return match[0].toUpperCase()
  }
  return null
}

function parseHfHub(): HfModelRef[] {
  const hubDir = join(homedir(), ".cache", "huggingface", "hub")
  if (!existsSync(hubDir)) return []

  const results: HfModelRef[] = []
  const entries = readdirSync(hubDir, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dirName = entry.name
    const match = dirName.match(/^models--(.+)--(.+)$/)
    if (!match) continue

    const org = match[1]!.replace(/-/g, "-")
    const modelName = match[2]!.replace(/-/g, "-")
    const modelDir = join(hubDir, dirName)

    const snapshotsDir = join(modelDir, "snapshots")
    let snapshots: string[] = []
    const allFiles: Array<{ name: string; size: number; path: string }> = []
    let isComplete = true

    if (existsSync(snapshotsDir)) {
      snapshots = readdirSync(snapshotsDir).filter((f) => f !== ".no_exist")
      for (const snap of snapshots) {
        const snapPath = join(snapshotsDir, snap)
        const files = walkDir(snapPath)
        for (const f of files) {
          allFiles.push(f)
        }
      }
    }

    const noExistDir = join(modelDir, ".no_exist")
    if (existsSync(noExistDir)) {
      isComplete = false
    }

    const totalBytes = allFiles.reduce((sum, f) => sum + f.size, 0)
    const detectedFormat = detectFormat(allFiles, org)

    results.push({
      org: org.replace(/--/g, "/"),
      name: modelName,
      path: modelDir,
      snapshots,
      totalBytes,
      isComplete,
      detectedFormat,
      quantization: detectQuantGguf(allFiles),
      fileCount: allFiles.length,
    })
  }

  return results
}

function getGgufFiles(ref: HfModelRef): Array<{ path: string }> {
  const results: Array<{ path: string }> = []
  for (const snap of ref.snapshots) {
    const snapPath = join(ref.path, "snapshots", snap)
    const files = walkDir(snapPath)
    for (const f of files) {
      if (f.name.toLowerCase().endsWith(".gguf")) {
        results.push({ path: f.path })
      }
    }
  }
  return results
}

/**
 * Resolve the actual .gguf file inside an HF hub cache model directory.
 *
 * The HF hub cache stores model files under snapshots/<hash>/ as symlinks to
 * blobs/<hash>, with refs/main pointing at the current snapshot hash. Passing
 * the bare repo directory (models--org--name) to llama-server fails with a
 * GGUF magic-number error; it needs the resolved .gguf file.
 *
 * Priority:
 *   1. Canonical snapshot target from refs/main (falling back to refs/master).
 *   2. First snapshot directory containing a non-mmproj .gguf.
 * Returns null when nothing resolvable is found.
 */
export function resolveHfGgufPath(modelDir: string): string | null {
  if (!existsSync(modelDir)) return null

  const pickFromSnapshot = (snapDir: string): string | null => {
    const ggufFiles = walkDir(snapDir).filter(
      (f) => f.name.toLowerCase().endsWith(".gguf") && !f.path.includes("mmproj")
    )
    return ggufFiles[0]?.path ?? null
  }

  const refsDir = join(modelDir, "refs")
  if (existsSync(refsDir)) {
    for (const refName of ["main", "master"]) {
      try {
        const target = readFileSync(join(refsDir, refName), "utf8").trim()
        if (!target) continue
        const found = pickFromSnapshot(join(modelDir, "snapshots", target))
        if (found) return found
      } catch {}
    }
  }

  const snapshotsDir = join(modelDir, "snapshots")
  if (existsSync(snapshotsDir)) {
    for (const snap of readdirSync(snapshotsDir)) {
      if (snap === ".no_exist") continue
      const found = pickFromSnapshot(join(snapshotsDir, snap))
      if (found) return found
    }
  }

  return null
}

export async function scanHfHub(): Promise<ModelRecord[]> {
  const models: ModelRecord[] = []
  const refs = parseHfHub()
  const now = new Date().toISOString()

  for (const ref of refs) {
    const modelFullName = `${ref.org}/${ref.name}`
    const id = `hf-${ref.org.replace(/\//g, "-")}-${ref.name}`.toLowerCase()

    let engine: ModelRecord["engine"] = null
    if (ref.detectedFormat === "gguf") {
      engine = "llama.cpp"
    } else if (ref.detectedFormat === "safetensors") {
      engine = "hf-transformers"
    } else if (ref.detectedFormat === "mlx" || ref.org.startsWith("mlx-community")) {
      engine = "mlx"
    }

    const ggufFiles = getGgufFiles(ref)
    const tags = determineTags(ref, ggufFiles)
    if (tags.includes("vocab")) continue

    const modelPath = ref.detectedFormat === "gguf"
      ? (ggufFiles.find((f) => !f.path.includes("mmproj"))?.path ?? ggufFiles[0]?.path ?? ref.path)
      : ref.path

    models.push({
      id,
      name: modelFullName,
      source: "hf-hub",
      sourceId: `huggingface/${modelFullName}`,
      path: modelPath,
      sizeBytes: ref.totalBytes,
      format: ref.detectedFormat,
      quantization: ref.quantization,
      engine,
      status: ref.isComplete ? "discovered" : "incomplete",
      metadata: {
        org: ref.org,
        modelName: ref.name,
        snapshots: ref.snapshots,
        isComplete: ref.isComplete,
        fileCount: ref.fileCount,
        tags,
        ...(() => {
          if (ref.detectedFormat !== "gguf" || !modelPath) return {}
          const meta = readGgufMetadata(modelPath)
          if (!meta) return {}
          return {
            ...(meta.context_length != null && { context_length: meta.context_length }),
            ...(meta.architecture != null && { architecture: meta.architecture }),
            ...(meta.file_type != null && { file_type: meta.file_type }),
            ...(meta.name != null && { gguf_name: meta.name }),
          }
        })(),
      },
      discoveredAt: now,
      updatedAt: now,
    })
  }

  return models
}
