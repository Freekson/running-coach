import 'server-only'

import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { workoutDefinitionSchema } from '@/schemas/workout-definition.v1'
import type { OwnerContext } from '@/server/authorization/ownership'
import { mapWorkoutToIntervals } from './workout-mapping'

export class PublicationError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'NOT_APPROVED'
      | 'STALE_REVISION'
      | 'BUSY'
      | 'RECOVERY_REQUIRED'
      | 'ACCOUNT_CHANGED'
      | 'REMOTE_CONFLICT'
      | 'PROVIDER_UNAVAILABLE'
      | 'PERMISSION_REQUIRED'
      | 'RATE_LIMITED'
      | 'EXPORT_UNVERIFIED',
    readonly writeRejected = false,
  ) {
    super('Workout publication could not be completed')
  }
}

export const publicationCommandSchema = z.strictObject({
  localWorkoutId: z.uuid(),
  expectedRevisionId: z.uuid(),
  expectedPublishRevision: z.number().int().nonnegative(),
})

export const approvedWorkoutSchema = z.strictObject({
  userId: z.uuid(),
  localWorkoutId: z.uuid(),
  revisionId: z.uuid(),
  approved: z.literal(true),
  // A cancellation is a tombstone in a new approved revision, never a deleted snapshot.
  cancelled: z.boolean(),
  locked: z.boolean(),
  workout: workoutDefinitionSchema,
  schedule: z.strictObject({ localDate: z.iso.date(), timeZone: z.string().min(1).max(100) }),
})
export type ApprovedPublicationWorkout = z.infer<typeof approvedWorkoutSchema>

/** RUN-33 must supply this from persisted current revisions, within the supplied
 * transaction. Lock its current-revision pointer until commit. Never implement
 * this by trusting a request payload, an AI import or a client approval flag. */
export type ApprovedWorkoutReader = (
  tx: Prisma.TransactionClient,
  owner: OwnerContext,
  localWorkoutId: string,
) => Promise<ApprovedPublicationWorkout | null>

export const publicationPayloadSchema = approvedWorkoutSchema.omit({ userId: true })
export type PublicationPayload = z.infer<typeof publicationPayloadSchema>

export const pendingPublicationWriteSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('UPSERT'), token: z.uuid() }),
  z.strictObject({ kind: z.literal('CANCEL'), remoteEventId: z.number().int().positive() }),
  // Existing uncertain receipts cannot retroactively prove a unique write marker.
  z.strictObject({ kind: z.literal('LEGACY') }),
])
export type PendingPublicationWrite = z.infer<typeof pendingPublicationWriteSchema>

export function publicationWriteTag(token: string) {
  return `running-coach-write:${token}`
}

export function publicationExternalId(userId: string, localWorkoutId: string) {
  // Includes owner identity, including when two users connect the same athlete account.
  return `running-coach:${userId}:${localWorkoutId}`
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      // Match JSON/Prisma persistence: undefined optional properties are absent.
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

export function publicationPayloadHash(payload: PublicationPayload) {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex')
}

export function publicationMapping(payload: PublicationPayload, externalId: string) {
  return mapWorkoutToIntervals({
    workout: payload.workout,
    schedule: payload.schedule,
    externalId,
    expandNestedRepeats: true,
  })
}
