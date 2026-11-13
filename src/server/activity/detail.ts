import 'server-only'
import { z } from 'zod'
import { getPrismaClient } from '@/server/db/client'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import type { ActivityDetail } from '@/lib/activity-detail'
import { activityHistoryRow } from './history'
import { activityReadScope } from './visibility'

const milliseconds = (value: bigint | null) =>
  value !== null && value >= 0 && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null

/** Saved summary and ordered laps only. Never downloads FIT or reads raw provider payloads. */
export async function getActivityDetail(
  owner: OwnerContext,
  id: string,
): Promise<ActivityDetail | null> {
  const userId = ownerId(owner)
  z.uuid().parse(id)
  const prisma = await getPrismaClient()
  const scope = await activityReadScope(owner)
  const row = await prisma.activity.findFirst({
    where: { AND: [scope, { id }] },
    select: {
      id: true,
      activityTitle: true,
      sportType: true,
      sourceSportType: true,
      sourceProvider: true,
      externalActivityId: true,
      externalActivityUuid: true,
      sourceTimezone: true,
      startedAt: true,
      distanceMeters: true,
      totalMs: true,
      movingMs: true,
      elapsedMs: true,
      avgSpeedMps: true,
      avgHrBpm: true,
      maxHrBpm: true,
      cadence: true,
      elevationGainMeters: true,
      elevationLossMeters: true,
      calories: true,
      lapImportStatus: true,
      laps: {
        where: { userId },
        orderBy: { lapIndex: 'asc' },
        select: {
          lapIndex: true,
          startedAt: true,
          distanceMeters: true,
          timerMs: true,
          movingMs: true,
          elapsedMs: true,
          avgSpeedMps: true,
          avgHrBpm: true,
          maxHrBpm: true,
          avgPowerWatts: true,
          maxPowerWatts: true,
          cadenceCyclesPerMinute: true,
          cadenceStepsPerMinute: true,
          elevationGainMeters: true,
        },
      },
    },
  })
  if (!row) return null
  const connection =
    row.sourceProvider === 'GARMIN'
      ? await prisma.integrationConnection.findUnique({
          where: { userId_provider: { userId, provider: 'GARMIN' } },
          select: { status: true, credential: { select: { connectionId: true } } },
        })
      : null
  return {
    ...activityHistoryRow(row),
    externalActivityId: row.externalActivityId,
    externalActivityUuid: row.externalActivityUuid,
    sourceTimezone: row.sourceTimezone,
    maxHrBpm: row.maxHrBpm,
    cadenceStepsPerMinute: row.cadence?.toNumber() ?? null,
    elevationGainMeters: row.elevationGainMeters?.toNumber() ?? null,
    elevationLossMeters: row.elevationLossMeters?.toNumber() ?? null,
    calories: row.calories,
    lapImportStatus: row.lapImportStatus,
    fitAvailability:
      row.sourceProvider !== 'GARMIN' || !/^\d{1,32}$/.test(row.externalActivityId ?? '')
        ? 'UNSUPPORTED'
        : connection?.status === 'CONNECTED' && connection.credential
          ? 'AVAILABLE'
          : 'NOT_CONNECTED',
    laps: row.laps.map((lap) => ({
      index: lap.lapIndex,
      startedAt: lap.startedAt?.toISOString() ?? null,
      distanceMeters: lap.distanceMeters?.toNumber() ?? null,
      timerMs: milliseconds(lap.timerMs),
      movingMs: milliseconds(lap.movingMs),
      elapsedMs: milliseconds(lap.elapsedMs),
      avgSpeedMps: lap.avgSpeedMps?.toNumber() ?? null,
      avgHrBpm: lap.avgHrBpm,
      maxHrBpm: lap.maxHrBpm,
      avgPowerWatts: lap.avgPowerWatts?.toNumber() ?? null,
      maxPowerWatts: lap.maxPowerWatts?.toNumber() ?? null,
      cadenceCyclesPerMinute: lap.cadenceCyclesPerMinute?.toNumber() ?? null,
      cadenceStepsPerMinute: lap.cadenceStepsPerMinute?.toNumber() ?? null,
      elevationGainMeters: lap.elevationGainMeters?.toNumber() ?? null,
    })),
  }
}
