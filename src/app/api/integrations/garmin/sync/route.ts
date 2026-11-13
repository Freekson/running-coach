import { z } from 'zod'
import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'
import { getOwnerContext } from '@/server/authorization/ownership'
import {
  CredentialConfigurationError,
  CredentialUnavailableError,
} from '@/server/provider/credential-crypto'
import {
  GarminAccountIdentityError,
  verifySavedGarminAccount,
} from '@/server/garmin/account-identity'
import { GarminAccountMismatchError } from '@/server/provider/vault'
import { GarminSyncUnavailableError, runGarminSync } from '@/server/garmin/sync'
import { getTrainingSyncState, runTrainingSync } from '@/server/garmin/training-sync'
import { GarminDataImportError } from '@/server/garmin/data-import-error'
import { allowGarminImport, getGarminImportBlock } from '@/server/garmin/import-rate-limit'

export const maxDuration = 60
const headers = { 'Cache-Control': 'private, no-store' }
const bodySchema = z.strictObject({
  extendDays: z.number().int().min(1).max(28).optional(),
  browserTimezone: z.string().min(1).max(100).default('UTC'),
})
function rateLimitedResponse(code: string, retryAt: string | null) {
  const until = retryAt ? Date.parse(retryAt) : NaN
  return Response.json(
    { code, retryAt },
    {
      status: 429,
      headers: Number.isFinite(until)
        ? { ...headers, 'Retry-After': String(Math.max(1, Math.ceil((until - Date.now()) / 1000))) }
        : headers,
    },
  )
}

async function boundedBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get('content-length')) > 256) return null
  const reader = request.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 256) {
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
    return Response.json(await getTrainingSyncState(getOwnerContext(user)), { headers })
  } catch (error) {
    if (error instanceof AccountUnavailableError)
      return new Response(null, { status: 403, headers })
    return Response.json({ error: 'Sync state unavailable' }, { status: 503, headers })
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
    owner = getOwnerContext(user)
    const state = await getTrainingSyncState(owner)
    if (state.status === 'SYNCING') return Response.json({ code: 'BUSY' }, { status: 409, headers })
    if (
      state.status === 'PAUSED' &&
      state.nextAttemptAt &&
      Date.parse(state.nextAttemptAt) > Date.now()
    )
      return Response.json(state, { headers })
    if (
      (body.data.extendDays !== undefined || state.errorCode === 'ACCOUNT_VERIFICATION_REQUIRED') &&
      !(await allowGarminImport(owner))
    ) {
      const block = await getGarminImportBlock(owner)
      return rateLimitedResponse(
        block?.code ?? 'RATE_LIMITED',
        block?.retryAt.toISOString() ?? null,
      )
    }
    if (state.errorCode === 'ACCOUNT_VERIFICATION_REQUIRED') await verifySavedGarminAccount(owner)
    return Response.json(
      body.data.extendDays !== undefined
        ? await runGarminSync(owner, { extendDays: body.data.extendDays })
        : await runTrainingSync(owner, body.data.browserTimezone),
      { headers },
    )
  } catch (error) {
    if (error instanceof AccountUnavailableError)
      return new Response(null, { status: 403, headers })
    if (error instanceof GarminAccountIdentityError)
      return Response.json(
        { code: error.code },
        { status: error.code === 'RATE_LIMITED' ? 429 : 422, headers },
      )
    if (error instanceof GarminAccountMismatchError)
      return Response.json({ code: error.code }, { status: 409, headers })
    if (error instanceof CredentialConfigurationError)
      return Response.json({ code: 'KEY_STORAGE_UNCONFIGURED' }, { status: 503, headers })
    if (error instanceof CredentialUnavailableError)
      return Response.json({ code: 'CREDENTIAL_CHANGED' }, { status: 409, headers })
    if (error instanceof GarminDataImportError) {
      if (error.code === 'RATE_LIMITED' && owner) {
        const state = await getTrainingSyncState(owner)
        return rateLimitedResponse(state.errorCode ?? 'RATE_LIMITED', state.nextAttemptAt)
      }
      return Response.json(
        { code: error.code },
        {
          status: error.code === 'BUSY' || error.code === 'NOT_READY' ? 409 : 422,
          headers,
        },
      )
    }
    if (error instanceof GarminSyncUnavailableError) {
      if (error.code === 'PAUSED' && owner) {
        const state = await getTrainingSyncState(owner)
        return rateLimitedResponse(state.errorCode ?? 'PAUSED', state.nextAttemptAt)
      }
      const status =
        error.code === 'BUSY'
          ? 409
          : error.code === 'PAUSED'
            ? 429
            : error.code === 'INVALID_EXTENSION'
              ? 400
              : 409
      return Response.json({ code: error.code }, { status, headers })
    }
    return Response.json({ error: 'Sync unavailable' }, { status: 503, headers })
  }
}
