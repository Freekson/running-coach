import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'
import { getOwnerContext } from '@/server/authorization/ownership'
import { exportAccount, serializeAccountExport } from '@/server/account/export'

export const runtime = 'nodejs'
const privateHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }

export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) return new Response(null, { status: 401, headers: privateHeaders })
    const archive = serializeAccountExport(await exportAccount(getOwnerContext(user)))
    // Stream the completed consistent snapshot so large archives do not become
    // buffered function responses. Never begin a download before the DB read succeeds.
    let offset = 0
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= archive.length) return controller.close()
        let end = Math.min(offset + 16_384, archive.length)
        // Do not split a UTF-16 surrogate pair between encoded chunks.
        if (end < archive.length && /[\uD800-\uDBFF]/.test(archive[end - 1])) end -= 1
        controller.enqueue(encoder.encode(archive.slice(offset, end)))
        offset = end
      },
    })
    return new Response(stream, {
      headers: {
        ...privateHeaders,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="running-coach-account.json"',
      },
    })
  } catch (error) {
    return Response.json(
      { error: 'Account export unavailable' },
      {
        status: error instanceof AccountUnavailableError ? 403 : 503,
        headers: privateHeaders,
      },
    )
  }
}
