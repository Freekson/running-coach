import 'server-only'

import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import { assertProviderApiKeySnapshotCurrent } from '@/server/provider/vault'
import { CredentialUnavailableError } from '@/server/provider/credential-crypto'

const MAX_IMPORTS = 3
const MAX_PROVIDER_RETRY_MS = 30 * 24 * 60 * 60 * 1000

/** A malformed Retry-After must not permanently pause both Garmin import paths. */
export function boundedGarminRetryAt(
  from: Date,
  requestedMs: number | undefined,
  minimumMs = 60_000,
): Date {
  const delay = requestedMs !== undefined && Number.isFinite(requestedMs) ? requestedMs : 0
  return new Date(from.getTime() + Math.min(MAX_PROVIDER_RETRY_MS, Math.max(minimumMs, delay)))
}

/** Allocate a per-owner order only while this verified Garmin key is still active. */
export async function reserveGarminHealthAttempt(
  owner: OwnerContext,
  credentialNonce: Uint8Array,
  garminAccountId: string,
): Promise<bigint> {
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  const rows = await prisma.$queryRaw<{ attemptSequence: bigint }[]>`
    WITH active_connection AS (
      SELECT connection.id
      FROM "integration_connections" AS connection
      JOIN "integration_credentials" AS credential
        ON credential.connection_id = connection.id
        AND credential.user_id = connection.user_id
      WHERE connection.user_id = ${userId}::uuid
        AND connection.provider = 'GARMIN'
        AND connection.status = 'CONNECTED'
        AND connection.external_account_id = ${garminAccountId}
        AND credential.nonce = ${credentialNonce}
      FOR UPDATE OF connection
    )
    INSERT INTO "garmin_import_rate_limits"
      ("user_id", "count", "window_started_at", "health_attempt_sequence")
    SELECT ${userId}::uuid, 1, CURRENT_TIMESTAMP, 1 FROM active_connection
    ON CONFLICT ("user_id") DO UPDATE SET
      "health_attempt_sequence" = "garmin_import_rate_limits"."health_attempt_sequence" + 1
    RETURNING "health_attempt_sequence" AS "attemptSequence"
  `
  if (rows.length !== 1) throw new CredentialUnavailableError()
  return rows[0].attemptSequence
}

/** Reserve one bounded import attempt across all app instances before contacting Garmin. */
export async function allowGarminImport(owner: OwnerContext): Promise<boolean> {
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  const rows = await prisma.$queryRaw<{ count: number; paused: boolean | null }[]>`
    WITH active_connection AS (
      SELECT connection.id
      FROM "integration_connections" AS connection
      JOIN "integration_credentials" AS credential
        ON credential.connection_id = connection.id
        AND credential.user_id = connection.user_id
      WHERE connection.user_id = ${userId}::uuid
        AND connection.provider = 'GARMIN'
        AND connection.status = 'CONNECTED'
      FOR UPDATE OF connection
    )
    INSERT INTO "garmin_import_rate_limits" ("user_id", "count", "window_started_at")
    SELECT ${userId}::uuid, 1, CURRENT_TIMESTAMP FROM active_connection
    ON CONFLICT ("user_id") DO UPDATE SET
      "count" = CASE
        WHEN "garmin_import_rate_limits"."provider_retry_at" > CURRENT_TIMESTAMP
          THEN "garmin_import_rate_limits"."count"
        WHEN "garmin_import_rate_limits"."window_started_at" <= CURRENT_TIMESTAMP - INTERVAL '60 seconds' THEN 1
        ELSE LEAST("garmin_import_rate_limits"."count" + 1, ${MAX_IMPORTS + 1})
      END,
      "window_started_at" = CASE
        WHEN "garmin_import_rate_limits"."provider_retry_at" > CURRENT_TIMESTAMP
          THEN "garmin_import_rate_limits"."window_started_at"
        WHEN "garmin_import_rate_limits"."window_started_at" <= CURRENT_TIMESTAMP - INTERVAL '60 seconds' THEN CURRENT_TIMESTAMP
        ELSE "garmin_import_rate_limits"."window_started_at"
      END
    RETURNING "count", ("provider_retry_at" > CURRENT_TIMESTAMP) AS "paused"
  `
  if (rows.length !== 1) throw new CredentialUnavailableError()
  return !rows[0].paused && rows[0].count <= MAX_IMPORTS
}

/** Explain a denied attempt without exposing provider payloads or another owner's state. */
export async function getGarminImportBlock(
  owner: OwnerContext,
  observedAt: Date = new Date(),
): Promise<{ code: 'PROVIDER_PAUSED' | 'APP_RATE_LIMITED'; retryAt: Date } | null> {
  const prisma = await getPrismaClient()
  const row = await prisma.garminImportRateLimit.findUnique({
    where: { userId: ownerId(owner) },
    select: { count: true, windowStartedAt: true, providerRetryAt: true },
  })
  if (!row) return null
  if (row.providerRetryAt && row.providerRetryAt > observedAt)
    return { code: 'PROVIDER_PAUSED', retryAt: row.providerRetryAt }
  const retryAt = new Date(row.windowStartedAt.getTime() + 60_000)
  if (row.count > MAX_IMPORTS && retryAt > observedAt) return { code: 'APP_RATE_LIMITED', retryAt }
  return null
}

export async function getGarminProviderPauseUntil(owner: OwnerContext): Promise<Date | null> {
  const prisma = await getPrismaClient()
  const row = await prisma.garminImportRateLimit.findUnique({
    where: { userId: ownerId(owner) },
    select: { providerRetryAt: true },
  })
  return row?.providerRetryAt ?? null
}

export async function pauseGarminProviderUntil(
  owner: OwnerContext,
  until: Date,
  credentialNonce: Uint8Array,
): Promise<void> {
  if (!Number.isFinite(until.getTime())) throw new Error('Invalid Garmin retry time')
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  await prisma.$transaction(async (tx) => {
    try {
      await assertProviderApiKeySnapshotCurrent(tx, owner, 'GARMIN', credentialNonce)
    } catch (error) {
      if (error instanceof CredentialUnavailableError) return
      throw error
    }
    await tx.$executeRaw`
      INSERT INTO "garmin_import_rate_limits"
        ("user_id", "count", "window_started_at", "provider_retry_at")
      VALUES (${userId}::uuid, 1, CURRENT_TIMESTAMP - INTERVAL '61 seconds', ${until})
      ON CONFLICT ("user_id") DO UPDATE SET
        "provider_retry_at" = GREATEST(
          "garmin_import_rate_limits"."provider_retry_at",
          EXCLUDED."provider_retry_at"
        )
    `
  })
}
