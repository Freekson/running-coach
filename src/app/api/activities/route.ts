import { z } from 'zod'
import { listActivities, InvalidActivityImportError } from '@/server/activity/import'
import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'
import { getOwnerContext } from '@/server/authorization/ownership'

const privateHeaders = { 'Cache-Control': 'private, no-store' }
const querySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
})

export async function GET(request: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) return new Response(null, { status: 401, headers: privateHeaders })
    const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if (!query.success)
      return Response.json(
        { error: 'Invalid activity query' },
        { status: 400, headers: privateHeaders },
      )
    const page = await listActivities(getOwnerContext(user), query.data.limit, query.data.cursor)
    return Response.json(page, { headers: privateHeaders })
  } catch (error) {
    if (error instanceof AccountUnavailableError)
      return new Response(null, { status: 403, headers: privateHeaders })
    if (error instanceof InvalidActivityImportError)
      return Response.json(
        { error: 'Invalid activity cursor' },
        { status: 400, headers: privateHeaders },
      )
    throw error
  }
}
