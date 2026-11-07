import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'
import { getOwnerContext } from '@/server/authorization/ownership'
import {
  addWeight,
  getWeightChartReadings,
  getWeightHistoryPage,
  WeightRequestConflictError,
  weightChartPeriodSchema,
  weightHistoryPageSchema,
  weightInputSchema,
} from '@/server/athlete/profile'

const privateHeaders = { 'Cache-Control': 'private, no-store' }

export async function GET(request: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) return new Response(null, { status: 401, headers: privateHeaders })
    const owner = getOwnerContext(user)
    const params = new URL(request.url).searchParams
    if (params.get('view') === 'chart') {
      const period = weightChartPeriodSchema.safeParse(params.get('period'))
      if (!period.success)
        return Response.json({ error: 'Invalid period' }, { status: 400, headers: privateHeaders })
      return Response.json(
        { items: await getWeightChartReadings(owner, period.data) },
        { headers: privateHeaders },
      )
    }
    if (params.get('view') === 'history') {
      const page = weightHistoryPageSchema.safeParse(params.get('page'))
      if (!page.success)
        return Response.json({ error: 'Invalid page' }, { status: 400, headers: privateHeaders })
      return Response.json(await getWeightHistoryPage(owner, page.data), {
        headers: privateHeaders,
      })
    }
    return Response.json({ error: 'Invalid view' }, { status: 400, headers: privateHeaders })
  } catch (error) {
    if (error instanceof AccountUnavailableError)
      return new Response(null, { status: 403, headers: privateHeaders })
    throw error
  }
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) return new Response(null, { status: 401, headers: privateHeaders })
    const owner = getOwnerContext(user)
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      return new Response(null, { status: 415, headers: privateHeaders })
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: privateHeaders })
    }
    const parsed = weightInputSchema.safeParse(body)
    if (!parsed.success)
      return Response.json({ error: 'Invalid weight' }, { status: 400, headers: privateHeaders })
    const measurement = await addWeight(owner, parsed.data)
    return Response.json(
      {
        id: measurement.id,
        measuredAt: measurement.measuredAt.toISOString(),
        measuredOn: measurement.measuredOn?.toISOString().slice(0, 10) ?? null,
        createdAt: measurement.createdAt.toISOString(),
        valueKg: measurement.value.toNumber(),
      },
      { status: 201, headers: privateHeaders },
    )
  } catch (error) {
    if (error instanceof AccountUnavailableError)
      return new Response(null, { status: 403, headers: privateHeaders })
    if (error instanceof WeightRequestConflictError)
      return Response.json(
        { error: 'Request ID already used for another reading' },
        { status: 409, headers: privateHeaders },
      )
    throw error
  }
}
