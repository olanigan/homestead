// Minimal stand-in HTTP server used by the fake llama-server fixture below. Not committed
// as executable itself — invoked by ./llama-server, which is what actually gets resolved
// by `which llama-server` in tests (see fixtures/README.md).
const args = process.argv.slice(2)
const get = (flag: string, def: string) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : def
}
const host = get("--host", "127.0.0.1")
const port = parseInt(get("--port", "8080"))
const startupDelayMs = parseInt(process.env.FAKE_LLAMA_STARTUP_DELAY_MS ?? "0")
const exitEarly = process.env.FAKE_LLAMA_EXIT_EARLY === "1"

if (exitEarly) {
  console.error("simulated early crash")
  process.exit(1)
}

let ready = startupDelayMs === 0
if (!ready) setTimeout(() => { ready = true }, startupDelayMs)

Bun.serve({
  hostname: host,
  port,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/health") {
      return ready ? new Response("ok", { status: 200 }) : new Response("loading", { status: 503 })
    }
    if (url.pathname === "/v1/chat/completions") {
      return Response.json({
        id: "fake",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "fake response" }, finish_reason: "stop" }],
        usage: { completion_tokens: 2, prompt_tokens: 1, total_tokens: 3 },
      })
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
  },
})
console.log(`fake-llama-server up on ${host}:${port}`)
