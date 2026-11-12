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
import { GarminHealthImportError } from '@/server/garmin/health-import'
import {
  GarminHealthSyncUnavailableError,
  getGarminHealthSyncState,
  localDay,
  runGarminHealthSync,
} from '@/server/garmin/health-sync'
import { allowGarminImport, getGarminImportBlock } from '@/server/garmin/import-rate-limit'
import { getHealthPreferredTimezone } from '@/server/health/history'
import { healthInitialImportReady } from '@/server/garmin/data-import'

export const maxDuration = 40
const headers = { 'Cache-Control': 'private, no-store' }
const bodySchema = z.strictObject({
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

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) return new Response(null, { status: 401, headers })
    if (request.headers.get('origin') !== new URL(request.url).origin)
      return new Response(null, { status: 403, headers })
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      return new Response(null, { status: 415, headers })
    if (Number(request.headers.get('content-length')) > 256)
      return new Response(null, { status: 413, headers })
    const body = await boundedBody(request)
    if (body === null) return new Response(null, { status: 413, headers })
    let decoded: unknown
    try {
      decoded = JSON.parse(body) as unknown
    } catch {
      return new Response(null, { status: 400, headers })
    }
    const parsed = bodySchema.safeParse(decoded)
    if (!parsed.success) return new Response(null, { status: 400, headers })
    const owner = getOwnerContext(user)
    if (!(await healthInitialImportReady(owner)))
      return Response.json({ code: 'INITIAL_IMPORT_REQUIRED' }, { status: 409, headers })
    const state = await getGarminHealthSyncState(owner)
    if (state.status === 'SYNCING') return Response.json({ code: 'BUSY' }, { status: 409, headers })
    if (
      state.status === 'PAUSED' &&
      state.nextAttemptAt &&
      Date.parse(state.nextAttemptAt) > Date.now()
    )
      return Response.json(state, { headers })
    const successAge = state.lastSuccessAt ? Date.now() - Date.parse(state.lastSuccessAt) : NaN
    if (state.status === 'SUCCESS' && successAge >= 0 && successAge < 3_600_000) {
      const preferredTimezone = await getHealthPreferredTimezone(owner)
      const timezone = preferredTimezone ?? parsed.data.browserTimezone
      try {
        if (state.window?.end === localDay(new Date(), timezone))
          return Response.json(state, { headers })
      } catch {
        // The sync service validates the fallback timezone before importing.
      }
    }
    if (!(await allowGarminImport(owner))) {
      const block = await getGarminImportBlock(owner)
      return Response.json(
        {
          code: block?.code ?? 'RATE_LIMITED',
          retryAt: block?.retryAt.toISOString() ?? null,
        },
        { status: 429, headers },
      )
    }
    if (state.errorCode === 'ACCOUNT_VERIFICATION_REQUIRED') await verifySavedGarminAccount(owner)
    return Response.json(await runGarminHealthSync(owner, parsed.data.browserTimezone), { headers })
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
    if (error instanceof GarminHealthSyncUnavailableError)
      return Response.json(
        { code: error.code },
        {
          status:
            error.code === 'PAUSED'
              ? 429
              : error.code === 'BUSY'
                ? 409
                : error.code === 'NOT_CONNECTED'
                  ? 409
                  : 503,
          headers,
        },
      )
    if (error instanceof GarminHealthImportError)
      return Response.json(
        { code: error.code },
        {
          status:
            error.code === 'INVALID_DATE'
              ? 400
              : error.code === 'RATE_LIMITED'
                ? 429
                : error.code === 'NOT_CONNECTED'
                  ? 409
                  : 503,
          headers,
        },
      )
    return Response.json({ error: 'Health import unavailable' }, { status: 503, headers })
  }
}
