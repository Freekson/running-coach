import { z } from 'zod'
import { planUuidSchema } from '@/schemas/plan-content.v1'
import type { RefreshDiff } from './plan-import'
import type { PublicationStatus } from './workout-publication'

export const revisionPublicationSchema = z.strictObject({
  planId: planUuidSchema,
  expectedRevisionId: planUuidSchema,
})
export const sendRevisionPublicationSchema = revisionPublicationSchema.extend({
  workoutId: planUuidSchema,
  reviewToken: z.string().regex(/^[a-f0-9]{64}$/),
  confirm: z.literal(true),
})
export type RevisionPublicationPreview = {
  planId: string
  revisionId: string
  changes: (RefreshDiff & {
    operation: 'CREATE' | 'UPDATE' | 'RESCHEDULE' | 'CANCEL'
    reviewToken: string
    expectedPublishRevision: number
    status: PublicationStatus | null
    baselineStatus: 'confirmed' | 'not_published' | 'unknown'
    remoteStateUncertain: boolean
    recovery?: { publicationId: string; publishRevision: number }
    recoveryOnly?: true
  })[]
}
