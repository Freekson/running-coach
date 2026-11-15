import { z } from 'zod'
import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'
import { getOwnerContext } from '@/server/authorization/ownership'
import {
  CredentialConfigurationError,
  CredentialUnavailableError,
} from '@/server/provider/credential-crypto'
import {
  disconnectProvider,
  getProviderConnectionStatus,
  apiKeySchema,
  CredentialWriteConflictError,
} from '@/server/provider/vault'
import {
  connectIntervals,
  IntervalsConnectionError,
  testIntervalsConnection,
} from '@/server/intervals/connection'

const privateHeaders = { 'Cache-Control': 'private, no-store' }
const bodySchema = z.strictObject({ apiKey: apiKeySchema })

function failure(error: unknown) {
  if (error instanceof AccountUnavailableError)
    return new Response(null, { status: 403, headers: privateHeaders })
  const code =
    error instanceof IntervalsConnectionError
      ? error.code
      : error instanceof CredentialWriteConflictError
        ? 'CONNECTION_CHANGED'
        : error instanceof CredentialConfigurationError
          ? 'KEY_STORAGE_UNCONFIGURED'
          : error instanceof CredentialUnavailableError
            ? 'CREDENTIAL_UNAVAILABLE'
            : 'CONNECTION_UNAVAILABLE'
  const status =
    code === 'INVALID_KEY'
      ? 422
      : code === 'RATE_LIMITED'
        ? 429
        : code === 'CREDENTIAL_UNAVAILABLE' || code === 'CONNECTION_CHANGED'
          ? 409
          : 503
  return Response.json({ code }, { status, headers: privateHeaders })
}

// Bound streamed input too; Content-Length is not trusted.
async function readKey(request: Request): Promise<Response | string> {
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    return new Response(null, { status: 415, headers: privateHeaders })
  if (Number(request.headers.get('content-length')) > 4096)
    return new Response(null, { status: 413, headers: privateHeaders })
  const reader = request.body?.getReader()
  if (!reader) return new Response(null, { status: 400, headers: privateHeaders })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 4096) {
        await reader.cancel()
        return new Response(null, { status: 413, headers: privateHeaders })
      }
      chunks.push(value)
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const parsed = bodySchema.safeParse(value)
    if (parsed.success) return parsed.data.apiKey
  } catch {
    // Malformed input is never reflected into the response.
  } finally {
    reader.releaseLock()
  }
  return new Response(null, { status: 400, headers: privateHeaders })
}

export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) return new Response(null, { status: 401, headers: privateHeaders })
    return Response.json(await getProviderConnectionStatus(getOwnerContext(user), 'INTERVALS'), {
      headers: privateHeaders,
    })
  } catch (error) {
    return failure(error)
  }
}

async function mutate(request: Request, action: 'connect' | 'test' | 'disconnect') {
  try {
    const user = await getCurrentUser()
    if (!user) return new Response(null, { status: 401, headers: privateHeaders })
    if (request.headers.get('origin') !== new URL(request.url).origin)
      return new Response(null, { status: 403, headers: privateHeaders })
    const owner = getOwnerContext(user)
    if (action === 'disconnect') {
      await disconnectProvider(owner, 'INTERVALS')
      return new Response(null, { status: 204, headers: privateHeaders })
    }
    if (action === 'test')
      return Response.json(await testIntervalsConnection(owner), { headers: privateHeaders })
    const key = await readKey(request)
    if (key instanceof Response) return key
    return Response.json(await connectIntervals(owner, key), { headers: privateHeaders })
  } catch (error) {
    return failure(error)
  }
}

export async function PUT(request: Request) {
  return mutate(request, 'connect')
}

export async function POST(request: Request) {
  return mutate(request, 'test')
}

export async function DELETE(request: Request) {
  return mutate(request, 'disconnect')
}
