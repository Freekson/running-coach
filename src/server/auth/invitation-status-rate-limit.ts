import 'server-only'

import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'
import { getPrismaClient } from '@/server/db/client'

const WINDOW_MS = 60_000
const MAX_CHECKS = 60
const MAX_LOCAL_CHECKS = 20
const MAX_LOCAL_CLIENTS = 4_096
const RATE_KEY_PREFIX = 'running-coach:invitation-status:ip:'
const RETENTION_MS = 24 * 60 * 60 * 1_000
const localChecks = new Map<string, { count: number; resetAt: number }>()

// Bounded opportunistic cleanup keeps one key per IP from living forever.
export async function pruneInvitationStatusRateLimits(now = Date.now()): Promise<number> {
  const prisma = await getPrismaClient()
  return prisma.$executeRaw`
    WITH expired AS (
      SELECT "id" FROM "auth_rate_limits"
      WHERE "lastRequest" < ${BigInt(now - RETENTION_MS)}
        AND "key" LIKE 'running-coach:invitation-status:ip:%'
      ORDER BY "lastRequest"
      LIMIT 100
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM "auth_rate_limits"
    WHERE "id" IN (SELECT "id" FROM expired)
  `
}

// Vercel replaces x-forwarded-for with the connecting client IP. Do not use
// other client-controlled headers for deployed requests.
export function invitationStatusClientIp(request: Request): string | null {
  const ip = request.headers.get('x-forwarded-for')
  if (ip && isIP(ip)) return ip
  return process.env.VERCEL_ENV ? null : 'local'
}

// The local gate rejects repeat requests before Neon; the database bucket
// preserves the per-client limit across function instances.
export async function allowInvitationStatusCheck(
  clientIp: string | null,
  now = Date.now(),
): Promise<boolean> {
  if (!clientIp || (!isIP(clientIp) && clientIp !== 'local')) return false
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) throw new Error('BETTER_AUTH_SECRET is required for invitation status checks')
  const clientKey = createHmac('sha256', secret).update(clientIp).digest('hex')
  const previous = localChecks.get(clientKey)
  const entry =
    previous && previous.resetAt > now
      ? { count: previous.count + 1, resetAt: previous.resetAt }
      : { count: 1, resetAt: now + WINDOW_MS }
  localChecks.delete(clientKey)
  localChecks.set(clientKey, entry)
  if (entry.count > MAX_LOCAL_CHECKS) return false
  if (localChecks.size > MAX_LOCAL_CLIENTS) localChecks.delete(localChecks.keys().next().value!)

  const prisma = await getPrismaClient()
  const rateKey = RATE_KEY_PREFIX + clientKey
  const current = BigInt(now)
  const windowStart = BigInt(now - WINDOW_MS)
  const rows = await prisma.$queryRaw<{ count: number; lastRequest: bigint }[]>`
    INSERT INTO "auth_rate_limits" ("id", "key", "count", "lastRequest")
    VALUES (${rateKey}, ${rateKey}, 1, ${current})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN "auth_rate_limits"."lastRequest" <= ${windowStart} THEN 1
        ELSE LEAST("auth_rate_limits"."count" + 1, ${MAX_CHECKS + 1})
      END,
      "lastRequest" = CASE
        WHEN "auth_rate_limits"."lastRequest" <= ${windowStart} THEN ${current}
        ELSE "auth_rate_limits"."lastRequest"
      END
    RETURNING "count", "lastRequest"
  `
  const row = rows[0]
  // Expected deletes exceed new keys at steady traffic; a failed maintenance
  // query does not make an otherwise valid invitation unavailable.
  if (Math.random() < 0.02) await pruneInvitationStatusRateLimits(now).catch(() => undefined)
  if (!row || row.count > MAX_CHECKS) {
    localChecks.set(clientKey, {
      count: MAX_LOCAL_CHECKS + 1,
      resetAt: row ? Number(row.lastRequest) + WINDOW_MS : now + 1_000,
    })
    return false
  }
  return true
}
