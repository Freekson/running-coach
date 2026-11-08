import {
  getScheduledOwnerContext,
  InvalidOwnerContextError,
  isScheduledBearer,
} from '@/server/authorization/ownership'
import { runGarminSync } from '@/server/garmin/sync'
import { allowGarminImport } from '@/server/garmin/import-rate-limit'
import { findScheduledGarminOwnerId } from '@/server/garmin/scheduled-sync'

export const maxDuration = 60
const headers = { 'Cache-Control': 'private, no-store' }

/** Prepared trigger; no vercel.json Cron is installed until approval and plan limits are checked. */
export async function GET(request: Request) {
  if (
    process.env.GARMIN_SCHEDULE_ENABLED !== 'true' ||
    process.env.GARMIN_SHARED_SYNC_APPROVED !== 'true'
  )
    return new Response(null, { status: 404, headers })
  if (!isScheduledBearer(request.headers.get('authorization') ?? ''))
    return new Response(null, { status: 401, headers })
  try {
    const userId = await findScheduledGarminOwnerId()
    if (!userId) return new Response(null, { status: 204, headers })
    const owner = getScheduledOwnerContext(userId, request.headers.get('authorization') ?? '')
    if (!(await allowGarminImport(owner))) return new Response(null, { status: 204, headers })
    const state = await runGarminSync(owner)
    return Response.json({ status: state.status }, { headers })
  } catch (error) {
    if (error instanceof InvalidOwnerContextError)
      return new Response(null, { status: 401, headers })
    return Response.json({ error: 'Scheduled sync unavailable' }, { status: 503, headers })
  }
}
