import type { Context } from "hono"

export interface ErrorBody {
  error: {
    message: string
    type: "invalid_request_error" | "server_error"
    code: string
  }
}

export function errorResponse(c: Context, status: number, message: string, type: ErrorBody["error"]["type"], code: string): Response {
  return c.json({ error: { message, type, code } } as ErrorBody, status as any)
}
