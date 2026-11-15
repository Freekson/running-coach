import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'
import { getOwnerContext } from '@/server/authorization/ownership'
import {
  CredentialUnavailableError,
  CredentialConfigurationError,
} from '@/server/provider/credential-crypto'
import { IntervalsPaceError } from '@/server/intervals/pace-policy'
import { preflightIntervalsPace } from '@/server/intervals/pace-preflight'
import { getIntervalsPaceStatus } from '@/server/intervals/pace-state'

export const maxDuration = 60
const headers = { 'Cache-Control': 'private, no-store' }

function failure(error: unknown): Response {
  if (error instanceof AccountUnavailableError) return new Response(null, { status: 403, headers })
  if (error instanceof CredentialConfigurationError)
    return Response.json({ code: 'KEY_STORAGE_UNCONFIGURED' }, { status: 503, headers })
  if (error instanceof CredentialUnavailableError)
    return Response.json({ code: 'CONNECTION_CHANGED' }, { status: 409, headers })
  if (error instanceof IntervalsPaceError) {
    const status =
      error.code === 'PERMISSION_REQUIRED'
        ? 403
        : error.code === 'INVALID_KEY'
          ? 422
          : error.code === 'RATE_LIMITED'
            ? 429
            : error.code === 'PROVIDER_UNAVAILABLE'
              ? 503
              : 409
    return Response.json({ code: error.code, message: error.message }, { status, headers })
  }
  return Response.json({ code: 'PROVIDER_UNAVAILABLE' }, { status: 503, headers })
}

export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) return new Response(null, { status: 401, headers })
    return Response.json(await getIntervalsPaceStatus(getOwnerContext(user)), { headers })
  } catch (error) {
    return failure(error)
  }
}

async function emptyBody(request: Request): Promise<boolean> {
  if (!request.body) return true
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 512) {
        await reader.cancel()
        return false
      }
      chunks.push(value)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    if (!raw) return true
    const body: unknown = JSON.parse(raw)
    return (
      body !== null &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      Object.keys(body).length === 0
    )
  } catch {
    return false
  } finally {
    reader.releaseLock()
  }
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) return new Response(null, { status: 401, headers })
    if (request.headers.get('origin') !== new URL(request.url).origin)
      return new Response(null, { status: 403, headers })
    if (!(await emptyBody(request))) return new Response(null, { status: 400, headers })
    const result = await preflightIntervalsPace(getOwnerContext(user))
    // The credential nonce/binding remains server-only for RUN-41.
    return Response.json(result.summary, { headers })
  } catch (error) {
    return failure(error)
  }
}
