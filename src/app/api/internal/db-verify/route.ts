import { timingSafeEqual } from 'node:crypto'
import { getPrismaClient } from '@/server/db/client'

export const runtime = 'nodejs'

const noStore = { 'Cache-Control': 'private, no-store' }

export async function HEAD(request: Request): Promise<Response> {
  const configuredToken = process.env.DB_VERIFY_TOKEN
  const suppliedToken = request.headers.get('x-db-verify-token')

  if (!configuredToken || Buffer.byteLength(configuredToken) < 32 || !suppliedToken) {
    return new Response(null, { status: 404, headers: noStore })
  }

  const configuredBytes = Buffer.from(configuredToken)
  const suppliedBytes = Buffer.from(suppliedToken)
  if (
    configuredBytes.length !== suppliedBytes.length ||
    !timingSafeEqual(configuredBytes, suppliedBytes)
  ) {
    return new Response(null, { status: 404, headers: noStore })
  }

  try {
    await getPrismaClient()
    return new Response(null, { status: 204, headers: noStore })
  } catch {
    return new Response(null, { status: 503, headers: noStore })
  }
}
