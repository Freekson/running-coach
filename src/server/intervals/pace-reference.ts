import 'server-only'

import { z } from 'zod'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import { IntervalsPaceError } from './pace-policy'

// Credential changes invalidate readiness, not the origin of settings left at the provider.
export const INTERVALS_PACE_REFERENCE_PREFIX = 'INTERVALS_PACE_REFERENCE_V1:'

export const paceReferenceSchema = z.strictObject({
  version: z.literal(1),
  settingsId: z.number().int().positive(),
  referenceVersion: z.number().int().positive(),
  technicalReferenceMps: z.number().positive(),
  provisionedFields: z.array(z.enum(['threshold_pace', 'pace_zones', 'pace_zone_names'])),
})
export type PaceReference = z.infer<typeof paceReferenceSchema>

/** Match the Run group returned by the authenticated provider request, never a client ID. */
export async function readIntervalsPaceReference(
  owner: OwnerContext,
  connectionId: string,
  settingsId: number,
): Promise<PaceReference | null> {
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  const row = await prisma.syncCursor.findFirst({
    where: {
      userId,
      connectionId,
      dataType: `${INTERVALS_PACE_REFERENCE_PREFIX}${settingsId}`,
      connection: { userId, provider: 'INTERVALS', status: 'CONNECTED' },
    },
    select: { cursorOrCheckpoint: true },
  })
  if (!row) return null
  const parsed = paceReferenceSchema.safeParse(row.cursorOrCheckpoint)
  if (!parsed.success || parsed.data.settingsId !== settingsId)
    throw new IntervalsPaceError('CONFIGURATION_CONFLICT')
  return parsed.data
}
