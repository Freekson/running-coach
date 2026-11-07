import { timingSafeEqual } from 'node:crypto'
import { getPrismaClient } from '@/server/db/client'
import { activeKeyVersion, proveKeyVersion } from '@/server/provider/credential-crypto'

export const runtime = 'nodejs'

const noStore = { 'Cache-Control': 'private, no-store' }

export async function HEAD(request: Request): Promise<Response> {
  const configuredToken = process.env.DB_VERIFY_TOKEN
  const suppliedToken = request.headers.get('x-db-verify-token')
  const challengeText = request.headers.get('x-credential-rotation-challenge')
  const versionText = request.headers.get('x-credential-key-version')
  if (
    !configuredToken ||
    Buffer.byteLength(configuredToken) < 32 ||
    !suppliedToken ||
    !challengeText
  )
    return new Response(null, { status: 404, headers: noStore })
  const expected = Buffer.from(configuredToken)
  const supplied = Buffer.from(suppliedToken)
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
    return new Response(null, { status: 404, headers: noStore })
  if (!/^[A-Za-z0-9_-]{43}$/.test(challengeText))
    return new Response(null, { status: 400, headers: noStore })
  const challenge = Buffer.from(challengeText, 'base64url')
  if (challenge.length !== 32 || challenge.toString('base64url') !== challengeText)
    return new Response(null, { status: 400, headers: noStore })
  if (!versionText || !/^[1-9]\d*$/.test(versionText) || !Number.isSafeInteger(Number(versionText)))
    return new Response(null, { status: 400, headers: noStore })

  try {
    await getPrismaClient()
    const activeVersion = activeKeyVersion()
    const runtimeUrl = new URL(process.env.DATABASE_URL ?? '')
    const databaseTarget = JSON.stringify([
      runtimeUrl.hostname.replace('-pooler.', '.'),
      runtimeUrl.port === '5432' ? '' : runtimeUrl.port,
      runtimeUrl.pathname,
      runtimeUrl.searchParams.get('schema') || 'public',
    ])
    const proof = proveKeyVersion(Number(versionText), challenge, databaseTarget)
    return new Response(null, {
      status: 204,
      headers: {
        ...noStore,
        'x-credential-key-version': versionText,
        'x-credential-active-version': String(activeVersion),
        'x-credential-key-proof': proof,
      },
    })
  } catch {
    return new Response(null, { status: 503, headers: noStore })
  }
}
