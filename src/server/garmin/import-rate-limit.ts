import 'server-only'

import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import { assertProviderApiKeySnapshotCurrent } from '@/server/provider/vault'
import { CredentialUnavailableError } from '@/server/provider/credential-crypto'

const MAX_IMPORTS = 3

/** Reserve one bounded import attempt across all app instances before contacting Garmin. */
export async function allowGarminImport(owner: OwnerContext): Promise<boolean> {
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  const rows = await prisma.$queryRaw<{ count: number; paused: boolean | null }[]>`
    INSERT INTO "garmin_import_rate_limits" ("user_id", "count", "window_started_at")
    VALUES (${userId}::uuid, 1, CURRENT_TIMESTAMP)
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
  return rows.length === 1 && !rows[0].paused && rows[0].count <= MAX_IMPORTS
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
