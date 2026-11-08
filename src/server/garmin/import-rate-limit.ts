import 'server-only'

import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'

const MAX_IMPORTS = 3

/** Reserve one bounded import attempt across all app instances before contacting Garmin. */
export async function allowGarminImport(owner: OwnerContext): Promise<boolean> {
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO "garmin_import_rate_limits" ("user_id", "count", "window_started_at")
    VALUES (${userId}::uuid, 1, CURRENT_TIMESTAMP)
    ON CONFLICT ("user_id") DO UPDATE SET
      "count" = CASE
        WHEN "garmin_import_rate_limits"."window_started_at" <= CURRENT_TIMESTAMP - INTERVAL '60 seconds' THEN 1
        ELSE LEAST("garmin_import_rate_limits"."count" + 1, ${MAX_IMPORTS + 1})
      END,
      "window_started_at" = CASE
        WHEN "garmin_import_rate_limits"."window_started_at" <= CURRENT_TIMESTAMP - INTERVAL '60 seconds' THEN CURRENT_TIMESTAMP
        ELSE "garmin_import_rate_limits"."window_started_at"
      END
    RETURNING "count"
  `
  return rows.length === 1 && rows[0].count <= MAX_IMPORTS
}
