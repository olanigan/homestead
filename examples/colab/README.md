# Homestead Colab Showcases

Runnable notebooks that serve Liquid AI's LFM2.5 family (and comparable ≤4B-class
competitors) through Homestead on a **free Google Colab T4 GPU**, then drive real
agentic tasks against them. Click "Open in Colab," pick T4, run all cells — no local
setup, no private-repo access required.

## Why T4 is enough

| Constraint | Reality | Why it doesn't block this series |
|---|---|---|
| 16GB VRAM (≈14–15GB usable) | Turing-generation, no native bf16 | Every model here ships as an int4/int8 GGUF — a few hundred MB to ~5GB, nowhere near the ceiling |
| Free-tier session limits | ~90min idle disconnect, a few hours connected cap | Every notebook here runs in minutes, not hours |
| Ephemeral disk | Every fresh runtime re-clones + re-downloads | Models are small enough (largest here ~5GB quantized) that this costs a minute, not a real constraint |
| No background daemon by default | Ollama needs one; llama.cpp doesn't | Notebooks try the real Homestead gateway (this repo, built fresh) first and fall back to a plain `llama-cpp-python` server the moment the gateway isn't healthy — see `colab_common.py` |

## Serving path: gateway-first, fallback-verified

Every notebook here follows the same pattern (`colab_common.py`):

1. Clone this repo fresh.
2. Attempt to build the real Homestead gateway (`bun install && bun run build:ts`,
   then `homestead provider start`) — best-effort model registration via
   `homestead import <path>`.
3. **Verify**, not assume: poll `/v1/models` and require it to actually list a
   registered model. If it doesn't (build failure, registration failure, whatever),
   automatically fall back to a plain `llama-cpp-python` OpenAI-compatible server.
4. Either way, the rest of the notebook talks to a real OpenAI-compatible
   `/v1/chat/completions` endpoint — which serving path answered is printed, not
   hidden.

A notebook that silently pretended the gateway worked when it actually fell back
would be worse than useless for anyone trying to reproduce a result, so every
notebook prints which path it actually used.

## Notebooks

| # | Notebook | Status | What it shows |
|---|---|---|---|
| 01 | [`01_quickstart_homestead_lfm2.ipynb`](./01_quickstart_homestead_lfm2.ipynb) | **Built** | Serve `LFM2.5-1.2B-Instruct`, one real tool-calling round trip. The template every other notebook clones. |
| 02 | [`02_model_battle_arena.ipynb`](./02_model_battle_arena.ipynb) | **Built** | 5 models (LFM2.5 350M/1.2B/2.6B/8B-A1B-MoE + non-Liquid `Spark-X2.5-4B`) × 5 real tool-calling tasks (a self-contained loop + structural scorer, no external harness dependency) → pass-rate + latency leaderboard. |
| 03 | Framework Showdown | Planned | Fix the winning model from 02, vary the framework (LangGraph / CrewAI / a hand-rolled loop like 02's) instead — isolates "framework tax" from model capability, the mirror image of 02. |
| 04 | Speculative Decoding Speed | Planned | `LFM2.5-2.6B` alone vs. paired with its `-DSpark` draft model — tok/s bar chart, same T4, same task suite. |
| 05 | Vision Agent | Planned | `LFM2.5-VL-1.6B`/`-3B`: a screenshot-grounded tool call (e.g. "click the button in this UI mockup"). |
| 06 | Thinking vs. Instant | Planned | `LFM2.5-1.2B-Thinking` vs. `-Instruct` on the multi-step-chain task — accuracy/latency tradeoff for reasoning-mode SLMs. |
| 07 | David vs. Goliath | Planned | Best <4B local agent from 02 vs. one big hosted API model, same task suite — cost + latency + quality story. |

03–07 are documented here as a roadmap, not stubbed files — building one means
following 01/02's pattern (clone → gateway-or-fallback → download → serve → drive a
real agentic task → score/plot), not starting from scratch.

## Model shortlist (as of Sept 2026 — re-check before relying on this)

The small-model landscape moves fast — always re-check
`hf://models?author=LiquidAI` and comparable orgs before building a new notebook off
this list:

| Model | Params | Notes |
|---|---|---|
| `LiquidAI/LFM2.5-230M(-GGUF)` | 230M | fastest smoke-test, tool-calling unreliable |
| `LiquidAI/LFM2.5-350M-GGUF` | 350M | lightweight tool-calling demos |
| `LiquidAI/LFM2.5-1.2B-Instruct(-GGUF)` | 1.2B | notebook 01/02 baseline |
| `LiquidAI/LFM2.5-1.2B-Thinking-GGUF` | 1.2B | reasoning-mode variant — notebook 06 |
| `LiquidAI/LFM2.5-2.6B(-GGUF)` | 2.6B | Liquid's own best quality/speed pick |
| `LiquidAI/LFM2.5-8B-A1B(-GGUF)` | 8.3B total / ~1.5B active MoE | fast despite size |
| `LiquidAI/LFM2.5-*-DSpark(-GGUF)` | draft models | speculative decoding — notebook 04 |
| `LiquidAI/LFM2.5-VL-450M/1.6B/3B(-GGUF)` | vision-language | notebook 05 |
| `XHToken/Spark-X2.5-4B` / `-1.7B` | 4B/1.7B | non-Liquid comparison point, Apache-2.0, shipped Aug 2026 |

Every GGUF download in these notebooks uses `colab_common.pick_and_download_gguf()`,
which lists a repo's actual files and picks a quant match at run time instead of
hardcoding a filename — HF quant-suffix naming shifts release to release, and a
hardcoded filename just 404s the moment it does.
