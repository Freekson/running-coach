import { z } from 'zod'
import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'
import { getOwnerContext } from '@/server/authorization/ownership'
import { CredentialConfigurationError } from '@/server/provider/credential-crypto'
import {
  GarminAccountIdentityError,
  verifyGarminApiKeyAccount,
} from '@/server/garmin/account-identity'
import {
  apiKeySchema,
  disconnectProvider,
  GarminAccountMismatchError,
  getProviderConnectionStatus,
  saveProviderApiKey,
} from '@/server/provider/vault'

const privateHeaders = { 'Cache-Control': 'private, no-store' }
const bodySchema = z.strictObject({ apiKey: apiKeySchema })

function safeFailure(error: unknown) {
  if (error instanceof AccountUnavailableError)
    return new Response(null, { status: 403, headers: privateHeaders })
  if (error instanceof CredentialConfigurationError)
    return Response.json(
      { code: 'KEY_STORAGE_UNCONFIGURED' },
      { status: 503, headers: privateHeaders },
    )
  if (error instanceof GarminAccountMismatchError)
    return Response.json({ code: error.code }, { status: 409, headers: privateHeaders })
  if (error instanceof GarminAccountIdentityError)
    return Response.json(
      { code: error.code },
      {
        status: error.code === 'RATE_LIMITED' ? 429 : error.code === 'INVALID_KEY' ? 400 : 422,
        headers: privateHeaders,
      },
    )
  return Response.json(
    { error: 'Credential operation unavailable' },
    { status: 503, headers: privateHeaders },
  )
}

function sameOrigin(request: Request) {
  return request.headers.get('origin') === new URL(request.url).origin
}

async function parseBoundedJson(request: Request): Promise<{ value?: unknown; tooLarge: boolean }> {
  if (!request.body) return { tooLarge: false }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 4096) {
        await reader.cancel()
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

export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) return new Response(null, { status: 401, headers: privateHeaders })
    const status = await getProviderConnectionStatus(getOwnerContext(user), 'GARMIN')
    return Response.json(status, { headers: privateHeaders })
  } catch (error) {
    return safeFailure(error)
  }
}

export async function PUT(request: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) return new Response(null, { status: 401, headers: privateHeaders })
    if (!sameOrigin(request)) return new Response(null, { status: 403, headers: privateHeaders })
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      return new Response(null, { status: 415, headers: privateHeaders })
    if (Number(request.headers.get('content-length')) > 4096)
      return new Response(null, { status: 413, headers: privateHeaders })
    const parsedBody = await parseBoundedJson(request)
    if (parsedBody.tooLarge) return new Response(null, { status: 413, headers: privateHeaders })
    if (parsedBody.value === undefined)
      return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: privateHeaders })
    const parsed = bodySchema.safeParse(parsedBody.value)
    if (!parsed.success)
      return Response.json({ error: 'Invalid API key' }, { status: 400, headers: privateHeaders })
    const accountId = await verifyGarminApiKeyAccount(parsed.data.apiKey)
    const status = await saveProviderApiKey(getOwnerContext(user), 'GARMIN', parsed.data.apiKey, {
      verifiedGarminAccountId: accountId,
    })
    return Response.json(status, { headers: privateHeaders })
  } catch (error) {
    return safeFailure(error)
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) return new Response(null, { status: 401, headers: privateHeaders })
    if (!sameOrigin(request)) return new Response(null, { status: 403, headers: privateHeaders })
    await disconnectProvider(getOwnerContext(user), 'GARMIN')
    return new Response(null, { status: 204, headers: privateHeaders })
  } catch (error) {
    return safeFailure(error)
  }
}
