import 'server-only'

import { AccountUnavailableError, getCurrentUser } from './current-user'

export async function requireAdmin(): Promise<Response | null> {
  try {
    const user = await getCurrentUser()
    if (!user) return new Response(null, { status: 401 })
    if (user.role !== 'ADMIN') return new Response(null, { status: 403 })
    return null
  } catch (error) {
    if (error instanceof AccountUnavailableError) return new Response(null, { status: 403 })
    throw error
  }
}

export function requireTrustedOrigin(request: Request): Response | null {
  const origin = request.headers.get('origin')
  const expected = new URL(request.url).origin
  return origin === expected ? null : new Response(null, { status: 403 })
}

export const privateHeaders = { 'Cache-Control': 'private, no-store' }
