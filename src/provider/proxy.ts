export function resolveProxyUrl(endpoint: string, path: string): string {
  const cleanEndpoint = endpoint.replace(/\/+$/, "")
  const cleanPath = path.startsWith("/") ? path : `/${path}`

  if (cleanEndpoint.endsWith("/v1") && cleanPath.startsWith("/v1/")) {
    return `${cleanEndpoint}${cleanPath.slice(3)}`
  }
  if (cleanEndpoint.endsWith("/v1") && cleanPath === "/v1") {
    return cleanEndpoint
  }
  return `${cleanEndpoint}${cleanPath}`
}

export async function proxyToEngine(endpoint: string, path: string, body: unknown): Promise<Response> {
  const url = resolveProxyUrl(endpoint, path)
  const isStream = typeof body === "object" && body !== null && (body as Record<string, unknown>).stream === true

  try {
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
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: {
          message: `Failed to proxy request to ${url}: ${err instanceof Error ? err.message : String(err)}`,
          type: "proxy_error",
          code: "engine_unreachable",
        },
      }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    )
  }
}

