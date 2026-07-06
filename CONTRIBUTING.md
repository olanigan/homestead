# Contributing to `homestead-ai`

## Code Conventions

- **No comments** — use descriptive TypeScript types and clear variable names
- **No emojis** in code, docs, or commit messages
- **`snake_case`** in SQLite, **`camelCase`** in TypeScript — `rowToModel()` at the boundary
- **127.0.0.1** not `localhost` — Bun DNS quirk

## Pull Request Process

1. Run `bun run src/homestead.ts discover` to confirm no regressions in scanning
2. Run `npm run typecheck` — zero errors required
3. Run `npm run build` — zero errors required
4. If adding a scanner, implement the `Scanner` interface from `src/types.ts`
5. If adding an engine adapter, implement the `EngineAdapter` interface from `src/types.ts`
6. Update `ARCHITECTURE.md` if the module map changes

## Development Setup

```bash
bun install
npm run build       # tsc + Vite frontend build
bun run src/homestead.ts discover   # Populate registry from your local models
bun run src/homestead.ts ui --port 3030  # Web dashboard
```

## Testing

There are no unit tests. Validation is done via live integration:

```bash
# Run a model end-to-end
bun run src/homestead.ts serve llama3.2:1b --port 8080 &
curl http://127.0.0.1:8080/v1/chat/completions -d '{
  "model": "llama3.2:1b",
  "messages": [{"role":"user","content":"hello"}]
}'
```


