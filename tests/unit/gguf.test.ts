import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readGgufHeader } from "../../src/core/gguf.js"

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
