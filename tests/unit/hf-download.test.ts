import { describe, test, expect } from "bun:test"
import { autoSelectMmproj, type GgufFile } from "../../src/core/hf-download.js"

function gguf(path: string, size = 100): GgufFile {
  return { path, size, isMmproj: path.split("/").pop()?.startsWith("mmproj-") ?? false }
}

describe("autoSelectMmproj", () => {
  test("adds a matching mmproj for a selected base file", () => {
    const all = [
      gguf("model/model.gguf"),
      gguf("model/mmproj-model.gguf"),
    ]
    const result = autoSelectMmproj([all[0]!], all)
    expect(result).toHaveLength(2)
    expect(result[1]?.path).toBe("model/mmproj-model.gguf")
  })

  test("does not duplicate an mmproj already selected", () => {
    const all = [
      gguf("model/model.gguf"),
      gguf("model/mmproj-model.gguf"),
    ]
    const result = autoSelectMmproj([all[0]!, all[1]!], all)
    expect(result).toHaveLength(2)
  })

  test("leaves selection unchanged when no mmproj exists", () => {
    const all = [gguf("model/model.gguf")]
    const result = autoSelectMmproj([all[0]!], all)
    expect(result).toHaveLength(1)
    expect(result[0]?.path).toBe("model/model.gguf")
  })

  test("ignores existing mmproj-only selections", () => {
    const all = [
      gguf("model/model.gguf"),
      gguf("model/mmproj-model.gguf"),
    ]
    const result = autoSelectMmproj([all[1]!], all)
    expect(result).toHaveLength(1)
    expect(result[0]?.isMmproj).toBe(true)
  })
})
