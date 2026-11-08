import { z } from 'zod'
import { getActivity } from '@/server/activity/import'
import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'
import { getOwnerContext } from '@/server/authorization/ownership'

const privateHeaders = { 'Cache-Control': 'private, no-store' }

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser()
    if (!user) return new Response(null, { status: 401, headers: privateHeaders })
    const { id } = await context.params
    if (!z.uuid().safeParse(id).success)
      return Response.json(
        { error: 'Invalid activity ID' },
        { status: 400, headers: privateHeaders },
      )
    const activity = await getActivity(getOwnerContext(user), id)
    if (!activity) return new Response(null, { status: 404, headers: privateHeaders })
    return Response.json(activity, { headers: privateHeaders })
  } catch (error) {
    if (error instanceof AccountUnavailableError)
      return new Response(null, { status: 403, headers: privateHeaders })
    throw error
  }
}
