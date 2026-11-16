import 'server-only'

import type { WorkoutPublication } from '@prisma/client'
import { z } from 'zod'
import {
  publicationPayloadHash,
  publicationPayloadSchema,
  type PublicationPayload,
} from './publication-contract'

export function confirmedPublicationPayload(
  row: Pick<
    WorkoutPublication,
    'lastConfirmedPayload' | 'payload' | 'status' | 'pendingWrite' | 'leaseToken'
  >,
): PublicationPayload | null {
  // Also supports settled rows written by the previous app during rollout.
  if (['PUBLISHED', 'CANCELLED'].includes(row.status) && !row.pendingWrite && !row.leaseToken)
    return publicationPayloadSchema.parse(row.payload)
  if (row.lastConfirmedPayload != null)
    return publicationPayloadSchema.parse(row.lastConfirmedPayload)
  return null
}

export function publicationOperation(
  payload: PublicationPayload,
  baseline: PublicationPayload | null,
  prior: Pick<WorkoutPublication, 'payload' | 'operation'> | null,
) {
  if (payload.cancelled) return 'CANCEL' as const
  if (baseline) {
    if (baseline.cancelled) return 'CREATE' as const
    return baseline.schedule.localDate !== payload.schedule.localDate ||
      baseline.schedule.timeZone !== payload.schedule.timeZone
      ? ('RESCHEDULE' as const)
      : ('UPDATE' as const)
  }
  if (!prior) return 'CREATE' as const
  // Retry the original operation; queued intent is never a confirmed baseline.
  if (
    publicationPayloadHash(publicationPayloadSchema.parse(prior.payload)) ===
    publicationPayloadHash(payload)
  )
    return z.enum(['CREATE', 'UPDATE', 'RESCHEDULE', 'CANCEL']).parse(prior.operation)
  // A legacy unresolved receipt has no reconstructable before-state.
  return 'UPDATE' as const
}
