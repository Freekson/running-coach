import { z } from 'zod'
import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'
import { getOwnerContext } from '@/server/authorization/ownership'
import { GarminImportError, importGarminActivitiesForDate } from '@/server/garmin/activity-import'
import { allowGarminImport } from '@/server/garmin/import-rate-limit'
import {
  GarminProviderLeaseUnavailableError,
  withGarminProviderLease,
} from '@/server/garmin/provider-lease'
import { CredentialUnavailableError } from '@/server/provider/credential-crypto'

const privateHeaders = { 'Cache-Control': 'private, no-store' }
const MAX_BODY_BYTES = 1024
const bodySchema = z.strictObject({
  date: z.iso.date(),
  start: z.number().int().min(0).max(300).optional(),
})

async function parseBoundedBody(request: Request): Promise<{ value?: unknown; tooLarge: boolean }> {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) return { tooLarge: true }
  if (!request.body) return { tooLarge: false }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES) {
        try {
          await reader.cancel()
        } catch {
          // The request is already rejected even if its stream cannot be cancelled.
        }
        return { tooLarge: true }
      }
      chunks.push(value)
    }
    return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, tooLarge: false }
  } catch {
    return { tooLarge: false }
  } finally {
    reader.releaseLock()
  }
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) return new Response(null, { status: 401, headers: privateHeaders })
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      return new Response(null, { status: 415, headers: privateHeaders })
    const parsedBody = await parseBoundedBody(request)
    if (parsedBody.tooLarge) return new Response(null, { status: 413, headers: privateHeaders })
    if (parsedBody.value === undefined)
      return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: privateHeaders })
    const parsed = bodySchema.safeParse(parsedBody.value)
    if (!parsed.success)
      return Response.json(
        { error: 'Invalid import date' },
        { status: 400, headers: privateHeaders },
      )
    const owner = getOwnerContext(user)
    if (!(await allowGarminImport(owner)))
      return Response.json(
        { error: 'Garmin import rate limit reached' },
        { status: 429, headers: privateHeaders },
      )
    const result = await withGarminProviderLease(owner, () =>
      importGarminActivitiesForDate(owner, parsed.data.date, { start: parsed.data.start }),
    )
    return Response.json(result, { headers: privateHeaders })
  } catch (error) {
    if (error instanceof GarminProviderLeaseUnavailableError)
      return Response.json(
        { error: 'Garmin import is busy' },
        { status: 409, headers: privateHeaders },
      )
    if (error instanceof AccountUnavailableError)
      return new Response(null, { status: 403, headers: privateHeaders })
    if (error instanceof CredentialUnavailableError)
      return Response.json(
        { error: 'Garmin connection unavailable' },
        { status: 409, headers: privateHeaders },
      )
    if (error instanceof GarminImportError)
      return Response.json(
        { error: error.code },
        {
          status:
            error.code === 'INVALID_DATE'
              ? 400
              : error.code === 'INVALID_KEY'
                ? 409
                : error.code === 'RATE_LIMITED'
                  ? 429
                  : error.code === 'STORAGE_UNAVAILABLE'
                    ? 503
                    : 502,
          headers: privateHeaders,
        },
      )
    throw error
  }
}
