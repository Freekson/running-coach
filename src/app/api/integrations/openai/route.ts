import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'
import { getOwnerContext } from '@/server/authorization/ownership'
import { disconnectProvider, getProviderConnectionStatus } from '@/server/provider/vault'

const privateHeaders = { 'Cache-Control': 'private, no-store' }

function safeFailure(error: unknown) {
  if (error instanceof AccountUnavailableError)
    return new Response(null, { status: 403, headers: privateHeaders })
  return Response.json(
    { error: 'Credential operation unavailable' },
    { status: 503, headers: privateHeaders },
  )
}

function sameOrigin(request: Request) {
  return request.headers.get('origin') === new URL(request.url).origin
}

export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) return new Response(null, { status: 401, headers: privateHeaders })
    const status = await getProviderConnectionStatus(getOwnerContext(user), 'OPENAI')
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
    await disconnectProvider(getOwnerContext(user), 'OPENAI')
    return new Response(null, { status: 204, headers: privateHeaders })
  } catch (error) {
    return safeFailure(error)
  }
}
