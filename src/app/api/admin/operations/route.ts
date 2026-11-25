import { privateHeaders } from '@/server/auth/admin-access'
import { getOperationalSummary, OperationalAccessError } from '@/server/observability/summary'

export const runtime = 'nodejs'

export async function GET() {
  try {
    const summary = await getOperationalSummary()
    return Response.json(summary ?? { error: 'UNAVAILABLE' }, {
      status: summary ? 200 : 503,
      headers: privateHeaders,
    })
  } catch (error) {
    return new Response(null, {
      status: error instanceof OperationalAccessError ? error.status : 503,
      headers: privateHeaders,
    })
  }
}
