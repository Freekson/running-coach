import { z } from 'zod'
import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'
import { getOwnerContext } from '@/server/authorization/ownership'
import { ActivityChartsError, loadActivityCharts } from '@/server/activity/charts'

export const maxDuration = 60
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }

/** Next.js can expose an empty POST as a stream. Reject data, not the stream itself. */
async function hasPayload(request: Request): Promise<boolean> {
  if (!request.body) return false
  const reader = request.body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return false
      if (value.byteLength > 0) {
        await reader.cancel().catch(() => {})
        return true
      }
    }
  } catch {
    return true
  } finally {
    reader.releaseLock()
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser()
    if (!user) return new Response(null, { status: 401, headers })
    if (request.headers.get('origin') !== new URL(request.url).origin)
      return new Response(null, { status: 403, headers })
    const { id } = await context.params
    if (!z.uuid().safeParse(id).success) return new Response(null, { status: 400, headers })
    if (await hasPayload(request)) return new Response(null, { status: 400, headers })
    return Response.json(await loadActivityCharts(getOwnerContext(user), id), { headers })
  } catch (error) {
    if (error instanceof AccountUnavailableError)
      return new Response(null, { status: 403, headers })
    if (error instanceof ActivityChartsError) {
      const retryAfter = error.retryAt
        ? String(Math.max(1, Math.ceil((error.retryAt.getTime() - Date.now()) / 1000)))
        : undefined
      return Response.json(
        { code: error.code, retryAt: error.retryAt?.toISOString() ?? null },
        {
          status: error.status,
          headers: { ...headers, ...(retryAfter ? { 'Retry-After': retryAfter } : {}) },
        },
      )
    }
    // Never serialize provider errors, raw records, coordinates, or credentials into errors/logs.
    return Response.json({ code: 'UNAVAILABLE', retryAt: null }, { status: 503, headers })
  }
}
