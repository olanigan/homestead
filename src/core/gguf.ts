import { openSync, readSync, closeSync } from "node:fs"

export interface GgufHeader {
  isGguf: boolean
  version: number
  tensorCount: number
  metadataKvCount: number
}

const HEADER_SIZE = 24
const GGUF_MAGIC = Buffer.from("GGUF")

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
