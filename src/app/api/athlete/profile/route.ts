import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'
import {
  profilePatchSchema,
  SexRequiredError,
  updateAthleteProfile,
} from '@/server/athlete/profile'

const privateHeaders = { 'Cache-Control': 'private, no-store' }

export async function PATCH(request: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) return new Response(null, { status: 401, headers: privateHeaders })
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      return new Response(null, { status: 415, headers: privateHeaders })
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: privateHeaders })
    }
    const parsed = profilePatchSchema.safeParse(body)
    if (!parsed.success)
      return Response.json(
        { error: 'Invalid profile fields' },
        { status: 400, headers: privateHeaders },
      )
    await updateAthleteProfile(user.id, parsed.data)
    return new Response(null, { status: 204, headers: privateHeaders })
  } catch (error) {
    if (error instanceof AccountUnavailableError)
      return new Response(null, { status: 403, headers: privateHeaders })
    if (error instanceof SexRequiredError)
      return Response.json(
        { error: 'Select male or female before saving the profile' },
        { status: 400, headers: privateHeaders },
      )
    throw error
  }
}
