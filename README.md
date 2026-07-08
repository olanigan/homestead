# `homestead-ai` — Your Local AI Harness

**Discover, track, and serve any local LLM from any engine — with one CLI.**

```
homestead discover   # Scan Ollama, HF cache, GGUF files, MLX, running engines
homestead list       # Tabular view of all models (or filtered)
homestead serve qwen # Auto-selects best engine, serves on :8080
homestead ui         # Web dashboard on :3030
```

`homestead` is the universal model agent harness for local AI. It treats Ollama,
llama.cpp, MLX, and Apple Core AI as first-class citizens in a single SQLite
registry — so you don't have to remember which engine has which model, or where
that GGUF file is buried.

## Quick Start

```bash
# Requires Bun
curl -fsSL https://bun.sh/install | bash

# Clone and run
npm install -g homestead-ai
git clone https://github.com/olanigan/homestead.git
cd homestead
bun install
homestead discover   # Find all your local models
homestead serve model-name  # Serve any model on :8080
homestead ui         # Launch the web dashboard
```

## Features

- **Zero-config discovery** — finds models in Ollama, HuggingFace cache, GGUF
  files, MLX directories, and running engines.
- **Cross-engine serving** — picks the best engine for any model (OllamaAdapter
  for Ollama models, LlamaCppAdapter for standalone GGUFs).
- **Audit trail** — every model load, unload, and error is logged to SQLite and
  streamed via SSE. Prove no data left your machine.
- **Observability dashboard** — real-time event stream, session tracking, and
  model health monitoring in the browser.
- **CLI-first** — designed for scripts, CI/CD, SSH, and agentic workflows.
  The UI is a monitoring dashboard, not a chatbot wrapper.

## Architecture

```
[Ollama] -----\
[HF Cache] ----> [ Scanner ] --> [ Registry ] --> [ Unified API ] --> [ Agent/UI ]
[Local GGUF] --/                    |
                                    v
                             [ SSE Event Stream ] --> [ Audit Dashboard ]
```

`homestead` is a horizontal orchestration layer — it does not replace your inference
engine. It sits above them all and provides a single pane of glass.

## License

Apache 2.0 OR MIT — your choice. See `LICENSE`.

For more information, visit https://homesteadai.dev.
