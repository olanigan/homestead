import type { ModelRecord } from "../../types.js"
import type { S1Adapter, SystemOneRequest, SystemOneResponse } from "../types.js"
import { ArLogitAdapter } from "./ar-logit.js"
import { DeciderAdapter } from "./decider.js"
import { LayaAdapter } from "./laya.js"
import { NanoJevAdapter } from "./nanojev.js"

export class S1EngineRouter {
  private adapters: S1Adapter[] = []

  constructor() {
    // Register standard S1 adapters
    this.adapters.push(new DeciderAdapter())
    this.adapters.push(new NanoJevAdapter())
    this.adapters.push(new LayaAdapter())
    this.adapters.push(new ArLogitAdapter())
  }

  public registerAdapter(adapter: S1Adapter): void {
    this.adapters.push(adapter)
  }

  public getAdapters(): S1Adapter[] {
    return [...this.adapters]
  }

  public getAdapterByName(name: string): S1Adapter | undefined {
    return this.adapters.find((a) => a.name.toLowerCase() === name.toLowerCase())
  }

  /**
   * Selects the optimal adapter given the request requirements and model metadata.
   */
  public selectAdapter(request: SystemOneRequest, model?: ModelRecord): S1Adapter {
    // 1. Explicit adapter requested by caller
    if (request.adapter && request.adapter !== "auto") {
      const explicit = this.getAdapterByName(request.adapter)
      if (explicit) return explicit
    }

    // 2. Inspect ModelRecord if provided
    if (model) {
      const matching = this.adapters
        .filter((a) => a.canHandle(model))
        .sort((a, b) => b.priority - a.priority)

      if (matching.length > 0 && matching[0]) {
        return matching[0]
      }
    }

    // 3. Inspect model name string from request
    if (request.model) {
      const matching = this.adapters
        .filter((a) => a.canHandle(request.model!))
        .sort((a, b) => b.priority - a.priority)

      if (matching.length > 0 && matching[0]) {
        return matching[0]
      }
    }

    // 4. Fallback to ArLogitAdapter
    const fallback = this.getAdapterByName("ar-logit") || this.adapters[this.adapters.length - 1]
    if (!fallback) {
      throw new Error("No S1 adapter available in S1EngineRouter")
    }
    return fallback
  }

  /**
   * Evaluates a SystemOneRequest through the resolved adapter.
   */
  public async evaluate(request: SystemOneRequest, model?: ModelRecord): Promise<SystemOneResponse> {
    const adapter = this.selectAdapter(request, model)
    return adapter.evaluate(request, model)
  }
}

export const s1Router = new S1EngineRouter()
