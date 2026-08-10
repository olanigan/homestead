export async function proxyToEngine(endpoint: string, path: string, body: unknown): Promise<Response> {
  const url = `${endpoint}${path}`
  const isStream = typeof body === "object" && body !== null && (body as Record<string, unknown>).stream === true

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text()
    return new Response(text, { status: response.status, headers: { "Content-Type": "application/json" } })
  }

  if (isStream) {
    return new Response(response.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })
  }

  const data = await response.json()
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  })
}
