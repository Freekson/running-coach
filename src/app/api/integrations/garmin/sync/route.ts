import { z } from 'zod'
import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'
import { getOwnerContext } from '@/server/authorization/ownership'
import { GarminSyncUnavailableError, getGarminSyncState, runGarminSync } from '@/server/garmin/sync'
import { allowGarminImport } from '@/server/garmin/import-rate-limit'

export const maxDuration = 60
const headers = { 'Cache-Control': 'private, no-store' }
const bodySchema = z.strictObject({ extendDays: z.number().int().min(1).max(28).optional() })

async function boundedBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get('content-length')) > 128) return null
  const reader = request.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 128) {
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
    return Response.json(await getGarminSyncState(getOwnerContext(user)), { headers })
  } catch (error) {
    if (error instanceof AccountUnavailableError)
      return new Response(null, { status: 403, headers })
    return Response.json({ error: 'Sync state unavailable' }, { status: 503, headers })
  }
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) return new Response(null, { status: 401, headers })
    if (request.headers.get('origin') !== new URL(request.url).origin)
      return new Response(null, { status: 403, headers })
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      return new Response(null, { status: 415, headers })
    const raw = await boundedBody(request)
    if (raw === null) return new Response(null, { status: 413, headers })
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch {
      return new Response(null, { status: 400, headers })
    }
    const body = bodySchema.safeParse(parsed)
    if (!body.success) return new Response(null, { status: 400, headers })
    const owner = getOwnerContext(user)
    if (!(await allowGarminImport(owner)))
      return Response.json({ code: 'PAUSED' }, { status: 429, headers })
    return Response.json(await runGarminSync(owner, body.data), { headers })
  } catch (error) {
    if (error instanceof AccountUnavailableError)
      return new Response(null, { status: 403, headers })
    if (error instanceof GarminSyncUnavailableError) {
      const status =
        error.code === 'BUSY'
          ? 409
          : error.code === 'PAUSED'
            ? 429
            : error.code === 'INVALID_EXTENSION'
              ? 400
              : error.code === 'APPROVAL_REQUIRED'
                ? 403
                : 409
      return Response.json({ code: error.code }, { status, headers })
    }
    return Response.json({ error: 'Sync unavailable' }, { status: 503, headers })
  }
}
