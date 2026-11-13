import 'server-only'
import { z } from 'zod'
import { getPrismaClient } from '@/server/db/client'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { assertProviderApiKeySnapshotCurrent } from '@/server/provider/vault'
import { CredentialUnavailableError } from '@/server/provider/credential-crypto'
import { openGarminActivitySession, GarminImportError } from '@/server/garmin/activity-import'
import { requestFit } from '@/server/garmin/personal-api-poc'
import {
  withGarminProviderLease,
  GarminProviderLeaseUnavailableError,
} from '@/server/garmin/provider-lease'
import { allowGarminImport, getGarminImportBlock } from '@/server/garmin/import-rate-limit'
import { normalizeActivityRecords } from '@/server/garmin/activity-records'
import { FitActivityIdentityError } from '@/server/garmin/normalization'
import { activityReadScope } from './visibility'

export class ActivityChartsError extends Error {
  constructor(
    readonly code: string,
    readonly status = 503,
    readonly retryAt: Date | null = null,
  ) {
    super('Activity charts unavailable')
  }
}
type Dependencies = {
  openSession?: typeof openGarminActivitySession
  downloadFit?: typeof requestFit
}

/** An explicit user request only. Uses shared quota/lease; never writes Activity or laps. */
export async function loadActivityCharts(
  owner: OwnerContext,
  id: string,
  dependencies: Dependencies = {},
) {
  const userId = ownerId(owner)
  z.uuid().parse(id)
  const prisma = await getPrismaClient()
  const scope = await activityReadScope(owner)
  const activity = await prisma.activity.findFirst({
    where: { AND: [scope, { id }] },
    select: {
      id: true,
      sourceProvider: true,
      externalActivityId: true,
      garminAccountId: true,
      startedAt: true,
      distanceMeters: true,
      elapsedMs: true,
      sportType: true,
      updatedAt: true,
    },
  })
  if (!activity) throw new ActivityChartsError('NOT_FOUND', 404)
  if (activity.sourceProvider !== 'GARMIN' || !/^\d{1,32}$/.test(activity.externalActivityId ?? ''))
    throw new ActivityChartsError('UNSUPPORTED', 422)
  const connection = await prisma.integrationConnection.findUnique({
    where: { userId_provider: { userId, provider: 'GARMIN' } },
    select: { status: true, credential: { select: { connectionId: true } } },
  })
  if (!connection?.credential || connection.status !== 'CONNECTED')
    throw new ActivityChartsError('NOT_CONNECTED')
  try {
    return await withGarminProviderLease(owner, async () => {
      if (!(await allowGarminImport(owner))) {
        const block = await getGarminImportBlock(owner)
        throw new ActivityChartsError('RATE_LIMITED', 429, block?.retryAt ?? null)
      }
      const deadlineAt = Date.now() + 40_000
      const session = await (dependencies.openSession ?? openGarminActivitySession)(owner, {
        expectedAccountId: activity.garminAccountId,
        deadlineAt,
      })
      const response = await (dependencies.downloadFit ?? requestFit)(
        session.fetcher,
        `/download-service/files/activity/${activity.externalActivityId}`,
        session.authorization,
        session.requestLimit(),
      )
      if (response.status === 'TOO_LARGE') throw new ActivityChartsError('FIT_TOO_LARGE', 422)
      if (response.status === 404 || response.status === 204)
        throw new ActivityChartsError('FIT_UNAVAILABLE', 422)
      await session.assertStatus(response)
      if (!response.bytes) throw new ActivityChartsError('INVALID_FIT', 422)
      let charts
      try {
        charts = normalizeActivityRecords(
          response.bytes,
          {
            startedAt: activity.startedAt.toISOString(),
            distanceMeters: activity.distanceMeters?.toNumber() ?? null,
            elapsedMs: activity.elapsedMs === null ? null : Number(activity.elapsedMs),
            sport: activity.sportType,
          },
          Math.min(deadlineAt, Date.now() + 5_000),
        )
      } catch (error) {
        throw new ActivityChartsError(
          error instanceof FitActivityIdentityError ? 'IDENTITY_MISMATCH' : 'INVALID_FIT',
          422,
        )
      }
      // Recheck connection and activity after the remote await: a disconnect/replacement/delete wins.
      await prisma.$transaction(async (tx) => {
        await assertProviderApiKeySnapshotCurrent(
          tx,
          owner,
          'GARMIN',
          session.credential.nonce,
          activity.garminAccountId,
        )
        const current = await tx.activity.findFirst({
          where: {
            userId,
            id,
            garminAccountId: activity.garminAccountId,
            updatedAt: activity.updatedAt,
          },
          select: { id: true },
        })
        if (!current) throw new ActivityChartsError('NOT_FOUND', 404)
      })
      return charts
    })
  } catch (error) {
    if (error instanceof GarminProviderLeaseUnavailableError)
      throw new ActivityChartsError('BUSY', 409)
    if (error instanceof CredentialUnavailableError)
      throw new ActivityChartsError('CREDENTIAL_CHANGED', 409)
    if (error instanceof GarminImportError) {
      if (error.code === 'RATE_LIMITED') {
        const block = await getGarminImportBlock(owner)
        throw new ActivityChartsError('RATE_LIMITED', 429, block?.retryAt ?? null)
      }
      throw new ActivityChartsError(
        error.code,
        ['ACCOUNT_MISMATCH', 'TOKEN_REJECTED'].includes(error.code) ? 409 : 503,
      )
    }
    throw error
  }
}
