import 'server-only'

import { Prisma } from '@prisma/client'
import { getPrismaClient } from '@/server/db/client'

/** Rotate by the most recent attempt, including failed attempts and connections not yet synced. */
export async function findScheduledGarminOwnerId(
  at: Date = new Date(),
  candidateOwnerIds?: readonly string[],
): Promise<string | null> {
  if (candidateOwnerIds?.length === 0) return null
  const prisma = await getPrismaClient()
  const scope = candidateOwnerIds
    ? Prisma.sql`AND connection.user_id IN (${Prisma.join(
        candidateOwnerIds.map((id) => Prisma.sql`${id}::uuid`),
      )})`
    : Prisma.empty
  const rows = await prisma.$queryRaw<{ userId: string }[]>`
    SELECT connection.user_id AS "userId"
    FROM integration_connections AS connection
    JOIN users AS owner ON owner.id = connection.user_id
    JOIN integration_credentials AS credential
      ON credential.connection_id = connection.id
      AND credential.user_id = connection.user_id
    LEFT JOIN sync_cursors AS cursor
      ON cursor.connection_id = connection.id
      AND cursor.user_id = connection.user_id
      AND cursor.data_type = 'ACTIVITIES'
    LEFT JOIN garmin_import_rate_limits AS import_limit
      ON import_limit.user_id = connection.user_id
    WHERE connection.provider = 'GARMIN'
      AND connection.status = 'CONNECTED'
      AND connection.external_account_id IS NOT NULL
      AND owner.status = 'ACTIVE'
      AND (import_limit.provider_retry_at IS NULL OR import_limit.provider_retry_at <= ${at})
      AND (
        import_limit.user_id IS NULL
        OR import_limit.window_started_at <= ${at} - INTERVAL '60 seconds'
        OR import_limit.count < 3
      )
      ${scope}
      AND (cursor.id IS NULL OR (
        (cursor.lease_expires_at IS NULL OR cursor.lease_expires_at <= ${at})
        AND (cursor.next_attempt_at IS NULL OR cursor.next_attempt_at <= ${at})
        AND COALESCE(cursor.cursor_or_checkpoint->>'actionRequired', 'false') <> 'true'
        AND (
          cursor.cursor_or_checkpoint->>'nextDate' IS NOT NULL
          OR cursor.last_synced_at IS NULL
          OR cursor.last_synced_at <= ${at} - INTERVAL '1 hour'
        )
      ))
    ORDER BY (
      SELECT MAX(run.started_at)
      FROM sync_runs AS run
      WHERE run.connection_id = connection.id
        AND run.user_id = connection.user_id
        AND run.job_type = 'GARMIN_ACTIVITIES'
    ) ASC NULLS FIRST, connection.id ASC
    LIMIT 1
  `
  return rows[0]?.userId ?? null
}
