import { z } from 'zod'
import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'
import { getOwnerContext } from '@/server/authorization/ownership'
import {
  GarminDataImportError,
  getGarminImportState,
  runGarminDataImport,
} from '@/server/garmin/data-import'
import { allowGarminImport, getGarminImportBlock } from '@/server/garmin/import-rate-limit'
import {
  GarminAccountIdentityError,
  verifySavedGarminAccount,
} from '@/server/garmin/account-identity'
import { GarminAccountMismatchError } from '@/server/provider/vault'

export const maxDuration = 60
const headers = { 'Cache-Control': 'private, no-store' }
function rateLimitedResponse(code: string, retryAt: Date | null): Response {
  const seconds = retryAt ? Math.max(1, Math.ceil((retryAt.getTime() - Date.now()) / 1_000)) : null
  return Response.json(
    { code, retryAt: retryAt?.toISOString() ?? null },
    {
      status: 429,
      headers: seconds ? { ...headers, 'Retry-After': String(seconds) } : headers,
    },
  )
}
const bodySchema = z.strictObject({
  streamId: z.enum(['daily_summary', 'sleep', 'activities']),
  action: z.enum(['import', 'resume', 'retry', 'reimport', 'verify']),
  browserTimezone: z.string().min(1).max(100),
})

async function boundedBody(request: Request): Promise<string | null> {
  const reader = request.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 256) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    reader.releaseLock()
  }
}

export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) return new Response(null, { status: 401, headers })
    return Response.json(await getGarminImportState(getOwnerContext(user)), { headers })
  } catch (error) {
    if (error instanceof AccountUnavailableError)
      return new Response(null, { status: 403, headers })
    return Response.json({ code: 'UNAVAILABLE' }, { status: 503, headers })
  }
}

export async function POST(request: Request) {
  let owner: ReturnType<typeof getOwnerContext> | null = null
  try {
    const user = await getCurrentUser()
    if (!user) return new Response(null, { status: 401, headers })
    if (request.headers.get('origin') !== new URL(request.url).origin)
      return new Response(null, { status: 403, headers })
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      return new Response(null, { status: 415, headers })
    if (Number(request.headers.get('content-length')) > 256)
      return new Response(null, { status: 413, headers })
    const raw = await boundedBody(request)
    if (raw === null) return new Response(null, { status: 413, headers })
    let decoded: unknown
    try {
      decoded = JSON.parse(raw) as unknown
    } catch {
      return new Response(null, { status: 400, headers })
    }
    const parsed = bodySchema.safeParse(decoded)
    if (!parsed.success) return new Response(null, { status: 400, headers })
    owner = getOwnerContext(user)
    const { streamId, action, browserTimezone } = parsed.data
    // TODO(RUN-76 follow-up): Enable this stream after Activities import is implemented.
    if (streamId === 'activities')
      return Response.json({ code: 'NOT_SUPPORTED' }, { status: 422, headers })
    if (action === 'verify') {
      if (!(await allowGarminImport(owner))) {
        const block = await getGarminImportBlock(owner)
        return rateLimitedResponse(block?.code ?? 'RATE_LIMITED', block?.retryAt ?? null)
      }
      await verifySavedGarminAccount(owner)
      return Response.json(await getGarminImportState(owner), { headers })
    }
    return Response.json(await runGarminDataImport(owner, { streamId, action, browserTimezone }), {
      headers,
    })
  } catch (error) {
    if (error instanceof AccountUnavailableError)
      return new Response(null, { status: 403, headers })
    if (error instanceof GarminAccountIdentityError) {
      if (error.code === 'RATE_LIMITED') {
        const block = owner ? await getGarminImportBlock(owner) : null
        return rateLimitedResponse(error.code, block?.retryAt ?? null)
      }
      return Response.json({ code: error.code }, { status: 422, headers })
    }
    if (error instanceof GarminAccountMismatchError)
      return Response.json({ code: error.code }, { status: 409, headers })
    if (error instanceof GarminDataImportError) {
      if (error.code === 'RATE_LIMITED') {
        const block = owner ? await getGarminImportBlock(owner) : null
        return rateLimitedResponse(error.code, block?.retryAt ?? null)
      }
      return Response.json(
        { code: error.code },
        {
          status:
            error.code === 'BUSY'
              ? 409
              : error.code === 'INVALID_TIMEZONE' ||
                  error.code === 'INVALID_CHECKPOINT' ||
                  error.code === 'NOT_STARTED' ||
                  error.code === 'NOT_READY'
                ? 422
                : 503,
          headers,
        },
      )
    }
    return Response.json({ code: 'UNAVAILABLE' }, { status: 503, headers })
  }
}
