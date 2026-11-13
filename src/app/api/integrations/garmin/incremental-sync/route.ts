import { z } from 'zod'
import { incrementalStreamSchema } from '@/lib/garmin-incremental-sync'
import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'
import { getOwnerContext } from '@/server/authorization/ownership'
import {
  getGarminIncrementalSyncState,
  runGarminIncrementalSync,
} from '@/server/garmin/incremental-sync'

export const maxDuration = 40
const headers = { 'Cache-Control': 'private, no-store' }
const bodySchema = z.strictObject({
  streamId: incrementalStreamSchema,
  connectionKey: z.string().min(1).max(100).optional(),
  browserTimezone: z
    .string()
    .min(1)
    .max(100)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: value })
        return true
      } catch {
        return false
      }
    }),
})

async function readBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get('content-length')) > 256) return null
  const reader = request.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
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
    return Response.json(await getGarminIncrementalSyncState(getOwnerContext(user)), { headers })
  } catch (error) {
    return new Response(null, {
      status: error instanceof AccountUnavailableError ? 403 : 503,
      headers,
    })
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
    const raw = await readBody(request)
    if (raw === null) return new Response(null, { status: 413, headers })
    let decoded: unknown
    try {
      decoded = JSON.parse(raw) as unknown
    } catch {
      return new Response(null, { status: 400, headers })
    }
    const body = bodySchema.safeParse(decoded)
    if (!body.success) return new Response(null, { status: 400, headers })
    const owner = getOwnerContext(user)
    const result = body.data.connectionKey
      ? await runGarminIncrementalSync(
          owner,
          body.data.streamId,
          body.data.browserTimezone,
          body.data.connectionKey,
        )
      : await runGarminIncrementalSync(owner, body.data.streamId, body.data.browserTimezone)
    return Response.json(result, { headers })
  } catch (error) {
    return new Response(null, {
      status: error instanceof AccountUnavailableError ? 403 : 503,
      headers,
    })
  }
}
