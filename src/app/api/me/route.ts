import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'

const privateHeaders = { 'Cache-Control': 'private, no-store' }

export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) return new Response(null, { status: 401, headers: privateHeaders })
    return Response.json(user, { headers: privateHeaders })
  } catch (error) {
    if (error instanceof AccountUnavailableError)
      return new Response(null, { status: 403, headers: privateHeaders })
    throw error
  }
}
