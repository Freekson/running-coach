import 'server-only'

import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { CredentialUnavailableError } from '@/server/provider/credential-crypto'
import {
  assertProviderApiKeySnapshotCurrent,
  readProviderApiKeySnapshot,
} from '@/server/provider/vault'
import { getPrismaClient } from '@/server/db/client'
import { requestIntervalsPaceSettings } from './pace-client'
import {
  assertPaceReadback,
  INTERVALS_DELIVERY_REFERENCE,
  IntervalsPaceError,
  missingIntervalsPaceSettings,
  parseIntervalsRunSettings,
  samePaceSettings,
} from './pace-policy'
import { claimIntervalsPaceLease, paceStatus, saveIntervalsPaceLease } from './pace-state'
import { mapWorkoutToIntervals } from './workout-mapping'
import { readIntervalsPaceReference, type PaceReference } from './pace-reference'

type Options = { fetcher?: typeof fetch; now?: () => Date; timeoutMs?: number }

/** Explicit delivery preparation only. No calendar writes and no Garmin calls.
 * The returned credential binding is server-only; routes expose summary alone. */
export async function preflightIntervalsPace(owner: OwnerContext, options: Options = {}) {
  ownerId(owner)
  const now = options.now ?? (() => new Date())
  const snapshot = await readProviderApiKeySnapshot(owner, 'INTERVALS')
  const lease = await claimIntervalsPaceLease(owner, snapshot.nonce, now())
  let checkpoint = lease.checkpoint
  try {
    const before = parseIntervalsRunSettings(
      await requestIntervalsPaceSettings(snapshot.key, options),
    )
    const patch = missingIntervalsPaceSettings(before)
    const priorReference = await readIntervalsPaceReference(owner, lease.connectionId, before.id)
    const retainedTechnical =
      priorReference !== null &&
      before.threshold_pace !== null &&
      before.threshold_pace !== undefined &&
      Math.abs(before.threshold_pace - priorReference.technicalReferenceMps) <= 0.000001
    const plannedCheckpoint: typeof checkpoint = {
      ...checkpoint,
      source:
        patch.threshold_pace || retainedTechnical
          ? 'technical-delivery-reference'
          : 'existing-user-configuration',
      referenceVersion: patch.threshold_pace
        ? INTERVALS_DELIVERY_REFERENCE.version
        : retainedTechnical
          ? priorReference.referenceVersion
          : null,
      technicalReferenceMps:
        patch.threshold_pace ?? (retainedTechnical ? priorReference.technicalReferenceMps : null),
      provisionedFields: [
        ...new Set([
          ...(priorReference?.provisionedFields ?? []),
          ...Object.keys(patch).filter(
            (key): key is 'threshold_pace' | 'pace_zones' | 'pace_zone_names' =>
              key === 'threshold_pace' || key === 'pace_zones' || key === 'pace_zone_names',
          ),
        ]),
      ],
    }
    const reference: PaceReference | undefined =
      plannedCheckpoint.source === 'technical-delivery-reference' &&
      plannedCheckpoint.referenceVersion !== null &&
      plannedCheckpoint.technicalReferenceMps !== null
        ? {
            version: 1,
            settingsId: before.id,
            referenceVersion: plannedCheckpoint.referenceVersion,
            technicalReferenceMps: plannedCheckpoint.technicalReferenceMps,
            provisionedFields: plannedCheckpoint.provisionedFields,
          }
        : undefined
    let after = before
    if (Object.keys(patch).length) {
      // Re-read before writing so an intervening UI edit is not replaced by a stale patch.
      const current = parseIntervalsRunSettings(
        await requestIntervalsPaceSettings(snapshot.key, options),
      )
      if (!samePaceSettings(before, current)) throw new IntervalsPaceError('CONFIGURATION_CHANGED')
      // Persist intent before the external effect so timeout recovery can reconcile it.
      await saveIntervalsPaceLease(
        owner,
        snapshot.nonce,
        lease,
        plannedCheckpoint,
        now(),
        false,
        reference,
      )
      checkpoint = plannedCheckpoint
      const prisma = await getPrismaClient()
      await prisma.$transaction((tx) =>
        assertProviderApiKeySnapshotCurrent(tx, owner, 'INTERVALS', snapshot.nonce),
      )
      await requestIntervalsPaceSettings(snapshot.key, { ...options, patch })
      after = parseIntervalsRunSettings(await requestIntervalsPaceSettings(snapshot.key, options))
    } else {
      checkpoint = plannedCheckpoint
    }
    assertPaceReadback(before, after, patch)
    checkpoint = {
      ...checkpoint,
      status: 'READY',
      verifiedAt: now().toISOString(),
      readback: 'VERIFIED',
      failureCode: null,
    }
    await saveIntervalsPaceLease(owner, snapshot.nonce, lease, checkpoint, now(), true, reference)
    return {
      summary: paceStatus(checkpoint),
      connectionId: lease.connectionId,
      credentialNonce: Uint8Array.from(snapshot.nonce),
    }
  } catch (error) {
    const safe =
      error instanceof CredentialUnavailableError
        ? new IntervalsPaceError('CONNECTION_CHANGED')
        : error instanceof IntervalsPaceError
          ? error
          : new IntervalsPaceError('PROVIDER_UNAVAILABLE')
    checkpoint = { ...checkpoint, status: 'FAILED', readback: 'FAILED', failureCode: safe.code }
    try {
      await saveIntervalsPaceLease(owner, snapshot.nonce, lease, checkpoint, now(), true)
    } catch {
      throw new IntervalsPaceError('CONNECTION_CHANGED')
    }
    throw safe
  }
}

/** RUN-41 supplies an owner-authorized approved definition, then verifies the
 * returned nonce again immediately before its explicit calendar write. */
export async function prepareIntervalsWorkout(
  owner: OwnerContext,
  input: unknown,
  options: Options = {},
) {
  ownerId(owner)
  const mapping = mapWorkoutToIntervals(input)
  const configuration = mapping.requirements.runPaceConfiguration
    ? await preflightIntervalsPace(owner, options)
    : null
  return { mapping, configuration }
}
