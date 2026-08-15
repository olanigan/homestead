import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readGgufHeader, readGgufMetadata, estimateParameterCount } from "../../src/core/gguf.js"

const KV_UINT32 = 4
const KV_STRING = 8

function writeString(chunks: Buffer[], s: string): void {
  const strBuf = Buffer.from(s, "utf-8")
  const lenBuf = Buffer.alloc(8)
  lenBuf.writeBigUInt64LE(BigInt(strBuf.length))
  chunks.push(lenBuf, strBuf)
}

/** Builds a minimal but structurally valid GGUF file with the given KV pairs. */
function buildGguf(kvs: Array<["string", string, string] | ["uint32", string, number]>): Buffer {
  const chunks: Buffer[] = []
  for (const kv of kvs) {
    const [kind, key] = kv
    writeString(chunks, key)
    const typeBuf = Buffer.alloc(4)
    if (kind === "string") {
      typeBuf.writeUInt32LE(KV_STRING)
      chunks.push(typeBuf)
      writeString(chunks, kv[2])
    } else {
      typeBuf.writeUInt32LE(KV_UINT32)
      chunks.push(typeBuf)
      const valBuf = Buffer.alloc(4)
      valBuf.writeUInt32LE(kv[2])
      chunks.push(valBuf)
    }
  }
  const body = Buffer.concat(chunks)

  const header = Buffer.alloc(24)
  header.write("GGUF", 0, "ascii")
  header.writeUInt32LE(3, 4)
  header.writeBigUInt64LE(0n, 8) // tensorCount — irrelevant for metadata parsing
  header.writeBigUInt64LE(BigInt(kvs.length), 16)

  return Buffer.concat([header, body])
}

describe("readGgufHeader", () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "homestead-gguf-"))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("returns null for a non-GGUF file", () => {
    const path = join(dir, "fake.gguf")
    writeFileSync(path, Buffer.from("not a gguf file at all"))
    expect(readGgufHeader(path)).toBeNull()
  })

  test("returns null for a missing file", () => {
    expect(readGgufHeader(join(dir, "does-not-exist.gguf"))).toBeNull()
  })

  test("parses a minimal GGUF header", () => {
    const path = join(dir, "minimal.gguf")
    const buf = Buffer.alloc(24)
    buf.write("GGUF", 0, "ascii")
    buf.writeUInt32LE(3, 4)
    buf.writeBigUInt64LE(2n, 8)
    buf.writeBigUInt64LE(1n, 16)
    writeFileSync(path, buf)
    const header = readGgufHeader(path)
    expect(header).not.toBeNull()
    expect(header?.isGguf).toBe(true)
    expect(header?.version).toBe(3)
    expect(header?.tensorCount).toBe(2)
    expect(header?.metadataKvCount).toBe(1)
  })
})

describe("readGgufMetadata", () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "homestead-gguf-meta-"))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("returns null for a non-GGUF file", () => {
    const path = join(dir, "fake.gguf")
    writeFileSync(path, Buffer.from("not a gguf file at all"))
    expect(readGgufMetadata(path)).toBeNull()
  })

  test("returns null for a missing file", () => {
    expect(readGgufMetadata(join(dir, "does-not-exist.gguf"))).toBeNull()
  })

  test("extracts architecture, name, file_type, and <arch>.context_length", () => {
    const path = join(dir, "full.gguf")
    writeFileSync(
      path,
      buildGguf([
        ["string", "general.architecture", "llama"],
        ["string", "general.name", "Qwen2.5-7B-Instruct"],
        ["uint32", "general.file_type", 7],
        ["uint32", "llama.context_length", 32768],
      ]),
    )
    const meta = readGgufMetadata(path)
    expect(meta).not.toBeNull()
    expect(meta?.architecture).toBe("llama")
    expect(meta?.name).toBe("Qwen2.5-7B-Instruct")
    expect(meta?.file_type).toBe(7)
    expect(meta?.context_length).toBe(32768)
  })

  test("returns an empty object (not null) when the file is GGUF but has no matching keys", () => {
    const path = join(dir, "irrelevant-keys.gguf")
    writeFileSync(path, buildGguf([["string", "tokenizer.ggml.model", "gpt2"]]))
    const meta = readGgufMetadata(path)
    expect(meta).not.toBeNull()
    expect(meta?.architecture).toBeUndefined()
    expect(meta?.context_length).toBeUndefined()
  })

  test("matches the KV key on suffix, so any architecture's *.context_length is captured", () => {
    const path = join(dir, "other-arch.gguf")
    writeFileSync(path, buildGguf([["uint32", "phi3.context_length", 4096]]))
    const meta = readGgufMetadata(path)
    expect(meta?.context_length).toBe(4096)
  })
})

describe("estimateParameterCount", () => {
  test("extracts a billions-scale size token", () => {
    expect(estimateParameterCount("Qwen2.5-7B-Instruct")).toBe("7B")
    expect(estimateParameterCount("LFM2-1.2B-Tool")).toBe("1.2B")
    expect(estimateParameterCount("LiquidAI/LFM2.5-Audio-1.5B-GGUF")).toBe("1.5B")
  })

  test("extracts a millions-scale size token", () => {
    expect(estimateParameterCount("SmolLM2-135M-Instruct-Q3_K_M")).toBe("135M")
    expect(estimateParameterCount("LFM2-350M")).toBe("350M")
  })

  test("picks the leftmost match for MoE-style names (total, not active, param count)", () => {
    expect(estimateParameterCount("LFM2-8B-A1B")).toBe("8B")
  })

  test("normalizes the unit letter to uppercase", () => {
    expect(estimateParameterCount("tiny-model-270m")).toBe("270M")
  })

  test("does not false-positive on quantization suffixes alone", () => {
    // "4_K_M" has no digit immediately adjacent to a bare B/M, so this must not
    // spuriously report a parameter count derived from the quant string.
    expect(estimateParameterCount("some-model-Q4_K_M")).toBeNull()
  })

  test("returns null when no size token is present", () => {
    expect(estimateParameterCount("mystery-model-instruct")).toBeNull()
  })

  test("does not match a bare trailing digit run with no B/M unit", () => {
    expect(estimateParameterCount("model-v2026")).toBeNull()
  })
})
