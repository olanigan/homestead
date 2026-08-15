import { openSync, readSync, closeSync } from "node:fs"

export interface GgufHeader {
  isGguf: boolean
  version: number
  tensorCount: number
  metadataKvCount: number
}

export interface GgufMetadata {
  context_length?: number
  architecture?: string
  file_type?: number
  name?: string
}

const HEADER_SIZE = 24
const GGUF_MAGIC = Buffer.from("GGUF")

// GGUF KV value types
const KV_UINT8 = 0
const KV_INT8 = 1
const KV_UINT16 = 2
const KV_INT16 = 3
const KV_UINT32 = 4
const KV_INT32 = 5
const KV_FLOAT32 = 6
const KV_BOOL = 7
const KV_STRING = 8
const KV_ARRAY = 9
const KV_UINT64 = 10
const KV_INT64 = 11
const KV_FLOAT64 = 12

class GgufReader {
  private buf: Buffer
  pos: number

  constructor(buf: Buffer) {
    this.buf = buf
    this.pos = 0
  }

  hasBytes(n: number): boolean { return this.pos + n <= this.buf.length }
  atEnd(): boolean { return this.pos >= this.buf.length }

  u8(): number { if (!this.hasBytes(1)) throw new Error("buffer overflow"); return this.buf.readUInt8(this.pos++) }
  i8(): number { if (!this.hasBytes(1)) throw new Error("buffer overflow"); return this.buf.readInt8(this.pos++) }
  u16(): number { if (!this.hasBytes(2)) throw new Error("buffer overflow"); const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v }
  i16(): number { if (!this.hasBytes(2)) throw new Error("buffer overflow"); const v = this.buf.readInt16LE(this.pos); this.pos += 2; return v }
  u32(): number { if (!this.hasBytes(4)) throw new Error("buffer overflow"); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v }
  i32(): number { if (!this.hasBytes(4)) throw new Error("buffer overflow"); const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v }
  f32(): number { if (!this.hasBytes(4)) throw new Error("buffer overflow"); const v = this.buf.readFloatLE(this.pos); this.pos += 4; return v }
  bool(): boolean { return this.u8() !== 0 }
  u64(): bigint { if (!this.hasBytes(8)) throw new Error("buffer overflow"); const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return v }
  i64(): bigint { if (!this.hasBytes(8)) throw new Error("buffer overflow"); const v = this.buf.readBigInt64LE(this.pos); this.pos += 8; return v }
  f64(): number { if (!this.hasBytes(8)) throw new Error("buffer overflow"); const v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v }

  string(): string {
    const len = Number(this.u64())
    if (!this.hasBytes(len)) throw new Error("buffer overflow")
    const s = this.buf.toString("utf-8", this.pos, this.pos + len)
    this.pos += len
    return s
  }

  skipValue(typeId: number): void {
    switch (typeId) {
      case KV_UINT8: case KV_INT8: case KV_BOOL: this.pos += 1; break
      case KV_UINT16: case KV_INT16: this.pos += 2; break
      case KV_UINT32: case KV_INT32: case KV_FLOAT32: this.pos += 4; break
      case KV_UINT64: case KV_INT64: case KV_FLOAT64: this.pos += 8; break
      case KV_STRING: { const len = Number(this.u64()); this.pos += len; break }
      case KV_ARRAY: {
        const elemType = this.u32()
        const len = Number(this.u64())
        for (let i = 0; i < len; i++) this.skipValue(elemType)
        break
      }
    }
  }

  readValue(typeId: number): unknown {
    switch (typeId) {
      case KV_UINT8: return this.u8()
      case KV_INT8: return this.i8()
      case KV_UINT16: return this.u16()
      case KV_INT16: return this.i16()
      case KV_UINT32: return this.u32()
      case KV_INT32: return this.i32()
      case KV_FLOAT32: return this.f32()
      case KV_BOOL: return this.bool()
      case KV_STRING: return this.string()
      case KV_UINT64: return Number(this.u64())
      case KV_INT64: return Number(this.i64())
      case KV_FLOAT64: return this.f64()
      case KV_ARRAY: {
        const elemType = this.u32()
        const len = Number(this.u64())
        const arr: unknown[] = []
        for (let i = 0; i < len; i++) arr.push(this.readValue(elemType))
        return arr
      }
      default: return undefined
    }
  }
}

export function readGgufHeader(filepath: string): GgufHeader | null {
  try {
    const fd = openSync(filepath, "r")
    const buf = Buffer.alloc(HEADER_SIZE)
    const bytesRead = readSync(fd, buf, 0, HEADER_SIZE, 0)
    closeSync(fd)

    if (bytesRead < HEADER_SIZE) return null

    const magic = buf.subarray(0, 4)
    if (!magic.equals(GGUF_MAGIC)) return null

    return {
      isGguf: true,
      version: buf.readUInt32LE(4),
      tensorCount: Number(buf.readBigUInt64LE(8)),
      metadataKvCount: Number(buf.readBigUInt64LE(16)),
    }
  } catch {
    return null
  }
}

// GGUF's KV spec has no universal "parameter count" key (unlike architecture/context_length/
// file_type, which general.* keys standardize) — some architectures expose their own, but
// there's no single key to read across all of them without a full tensor-shape walk. Instead,
// estimate from the common "<size>B"/"<size>M" naming convention (e.g. "Qwen2.5-7B-Instruct",
// "LFM2-1.2B-Tool", "SmolLM2-135M-Instruct") that HF repo names and GGUF filenames already
// follow in practice. Best-effort by design — returns null rather than guessing when no size
// token is present, and picks the first (leftmost) match so MoE names like "LFM2-8B-A1B" report
// the total parameter count, not the per-expert active count.
const PARAM_COUNT_PATTERN = /(?<![A-Za-z0-9])(\d+(?:\.\d+)?)([BM])(?![A-Za-z0-9])/i

export function estimateParameterCount(name: string): string | null {
  const match = name.match(PARAM_COUNT_PATTERN)
  if (!match) return null
  return `${match[1]}${match[2]!.toUpperCase()}`
}

export function readGgufMetadata(filepath: string): GgufMetadata | null {
  try {
    const fd = openSync(filepath, "r")
    // Read enough to cover header + KV section. 16MB handles large tokenizer arrays.
    const MAX_READ = 16 * 1024 * 1024
    const buf = Buffer.alloc(MAX_READ)
    const bytesRead = readSync(fd, buf, 0, MAX_READ, 0)
    closeSync(fd)

    if (bytesRead < HEADER_SIZE) return null
    const magic = buf.subarray(0, 4)
    if (!magic.equals(GGUF_MAGIC)) return null

    const kvCount = Number(buf.readBigUInt64LE(16))
    const reader = new GgufReader(buf)
    reader.pos = HEADER_SIZE

    const meta: GgufMetadata = {}
    for (let i = 0; i < kvCount; i++) {
      if (reader.atEnd()) break
      try {
        const key = reader.string()
        const typeId = reader.u32()
        const value = reader.readValue(typeId)

        if (key === "general.architecture" && typeof value === "string") meta.architecture = value
        else if (key === "general.name" && typeof value === "string") meta.name = value
        else if (key === "general.file_type" && typeof value === "number") meta.file_type = value
        else if (key.endsWith(".context_length") && typeof value === "number") meta.context_length = value
      } catch {
        break
      }
    }

    return meta
  } catch {
    return null
  }
}
