import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'
import { getOwnerContext } from '@/server/authorization/ownership'
import { deleteAllImportedGarminData } from '@/server/provider/vault'

const headers = { 'Cache-Control': 'private, no-store' }

export async function DELETE(request: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) return new Response(null, { status: 401, headers })
    if (request.headers.get('origin') !== new URL(request.url).origin)
      return new Response(null, { status: 403, headers })
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      return new Response(null, { status: 415, headers })
    if (Number(request.headers.get('content-length')) > 128)
      return new Response(null, { status: 413, headers })
    if (!request.body) return new Response(null, { status: 400, headers })
    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > 128) return new Response(null, { status: 413, headers })
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    let body: unknown
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch {
      return new Response(null, { status: 400, headers })
    }
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !('confirm' in body) ||
      body.confirm !== 'DELETE_ALL_GARMIN_DATA'
    )
      return new Response(null, { status: 400, headers })
    await deleteAllImportedGarminData(getOwnerContext(user))
    return new Response(null, { status: 204, headers })
  } catch (error) {
    if (error instanceof AccountUnavailableError)
      return new Response(null, { status: 403, headers })
    return new Response(null, { status: 503, headers })
  }
}
