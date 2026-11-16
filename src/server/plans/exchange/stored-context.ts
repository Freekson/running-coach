import 'server-only'

import type { Prisma, SyncCursor } from '@prisma/client'
import { z } from 'zod'
import { addHealthDays, healthLocalDay } from '@/lib/health-history'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import {
  confirmedActivityWindowSchema,
  confirmedActivityWindows,
} from '@/server/garmin/activity-coverage'
import {
  coverageSchema,
  type HistoryCoverage,
  type EvidenceMetric,
  trainingContextSchema,
} from '@/schemas/training-context.v1'

const checkpointSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    timezone: z.string(),
    nextDate: z.iso.date().nullable(),
    confirmedWindows: z.array(confirmedActivityWindowSchema).max(100).optional(),
  })
  .refine(
    (c) =>
      c.startDate <= c.endDate &&
      (c.nextDate === null || (c.nextDate >= c.startDate && c.nextDate <= c.endDate)),
  )
const healthCheckpointSchema = checkpointSchema.safeExtend({
  failedDates: z.array(z.iso.date()).max(8000),
})
type Cursor = Pick<SyncCursor, 'cursorOrCheckpoint' | 'lastSyncedAt' | 'consecutiveFailures'> & {
  dataType?: string
}
type Period = { startDate: string; endDate: string }

function compress(dates: string[]): Period[] {
  const periods: Period[] = []
  for (const date of [...new Set(dates)].sort()) {
    const last = periods.at(-1)
    if (last && addHealthDays(last.endDate, 1) === date) last.endDate = date
    else periods.push({ startDate: date, endDate: date })
  }
  return periods
}

/** Cursor coverage is checked history, never inferred from whether activities exist. */
export function activityCoverage(
  cursors: readonly Cursor[],
  timezone: string,
  now: Date,
): HistoryCoverage {
  const endDate = addHealthDays(healthLocalDay(now.toISOString(), timezone), -1)
  const startDate = addHealthDays(endDate, -83)
  const dates = Array.from({ length: 84 }, (_, i) => addHealthDays(startDate, i))
  const valid = cursors.flatMap((row) => {
    const c = checkpointSchema.safeParse(row.cursorOrCheckpoint)
    return c.success && c.data.timezone === timezone
      ? [
          {
            ...row,
            checkpoint: c.data,
            confirmed: confirmedActivityWindows(c.data, row.lastSyncedAt, now),
          },
        ]
      : []
  })
  const complete = dates.filter((date) =>
    valid.some((row) =>
      row.confirmed.some((window) => window.startDate <= date && date <= window.endDate),
    ),
  )
  const failed = dates.filter((date) =>
    valid.some(
      (row) =>
        row.consecutiveFailures > 0 &&
        row.checkpoint.nextDate !== null &&
        date >= row.checkpoint.startDate &&
        date <= row.checkpoint.nextDate,
    ),
  )
  const missing = dates.filter((date) => !complete.includes(date) && !failed.includes(date))
  const historical = valid.find((row) => row.dataType === 'GARMIN_IMPORT_ACTIVITIES')
  return coverageSchema.parse({
    status:
      complete.length === 84 && !failed.length
        ? 'sufficient'
        : valid.length
          ? 'partial'
          : 'unknown',
    provider: 'GARMIN',
    timezone,
    window: { startDate, endDate },
    lastManualSyncAt:
      valid
        .flatMap((row) =>
          row.lastSyncedAt && row.lastSyncedAt <= now ? [row.lastSyncedAt.toISOString()] : [],
        )
        .sort()
        .at(-1) ?? null,
    completeWindows: compress(complete),
    failedWindows: compress(failed),
    unfetchedWindows: compress(missing),
    label: 'recorded history only',
    historicalImport: {
      status: historical
        ? historical.checkpoint.nextDate === null && historical.consecutiveFailures === 0
          ? 'complete'
          : 'partial'
        : 'unknown',
      window: historical
        ? { startDate: historical.checkpoint.startDate, endDate: historical.checkpoint.endDate }
        : null,
    },
  })
}

export async function readStoredActivityCoverage(
  tx: Prisma.TransactionClient,
  owner: OwnerContext,
  timezone: string,
  now: Date,
) {
  const userId = ownerId(owner)
  const connection = await tx.integrationConnection.findUnique({
    where: { userId_provider: { userId, provider: 'GARMIN' } },
    select: { id: true, externalAccountId: true },
  })
  const cursors = connection?.externalAccountId
    ? await tx.syncCursor.findMany({
        where: {
          userId,
          connectionId: connection.id,
          dataType: { in: ['GARMIN_IMPORT_ACTIVITIES', 'GARMIN_IMPORT_ACTIVITIES_RECENT'] },
        },
        select: {
          dataType: true,
          cursorOrCheckpoint: true,
          lastSyncedAt: true,
          consecutiveFailures: true,
        },
        orderBy: { dataType: 'asc' },
      })
    : []
  return activityCoverage(cursors, timezone, now)
}

export async function readStoredRecovery(
  tx: {
    integrationConnection: Pick<Prisma.TransactionClient['integrationConnection'], 'findUnique'>
    syncCursor: Pick<Prisma.TransactionClient['syncCursor'], 'findMany'>
    dailyHealthMetric: Pick<Prisma.TransactionClient['dailyHealthMetric'], 'findMany'>
  },
  owner: OwnerContext,
  timezone: string,
  now: Date,
) {
  const userId = ownerId(owner)
  const endDate = addHealthDays(healthLocalDay(now.toISOString(), timezone), -1)
  const startDate = addHealthDays(endDate, -27)
  const period = { startDate, endDate }
  const connection = await tx.integrationConnection.findUnique({
    where: { userId_provider: { userId, provider: 'GARMIN' } },
    select: { id: true, externalAccountId: true },
  })
  const healthCursors = connection?.externalAccountId
    ? await tx.syncCursor.findMany({
        where: {
          userId,
          connectionId: connection.id,
          dataType: { in: ['GARMIN_IMPORT_DAILY_SUMMARY', 'GARMIN_IMPORT_SLEEP'] },
        },
        select: { cursorOrCheckpoint: true },
      })
    : []
  const failedDates = healthCursors.flatMap((row) => {
    const parsed = healthCheckpointSchema.safeParse(row.cursorOrCheckpoint)
    return parsed.success && parsed.data.timezone === timezone
      ? parsed.data.failedDates.filter((date) => date >= startDate && date <= endDate)
      : []
  })
  const rows = connection?.externalAccountId
    ? await tx.dailyHealthMetric.findMany({
        where: {
          userId,
          sourceProvider: 'GARMIN',
          garminAccountId: connection.externalAccountId,
          localDate: { gte: new Date(startDate), lte: new Date(endDate) },
        },
        select: {
          localDate: true,
          sourceTimezone: true,
          sleepSourceTimezone: true,
          restingHrBpm: true,
          hrvMs: true,
          sleepDurationMs: true,
          summaryFetchedAt: true,
          sleepFetchedAt: true,
        },
        orderBy: { localDate: 'asc' },
        take: 28,
      })
    : []
  const meaningfulHrv =
    rows.filter(
      (r) =>
        r.hrvMs !== null &&
        r.summaryFetchedAt &&
        r.summaryFetchedAt <= now &&
        r.sourceTimezone === timezone,
    ).length >= 7
  const checked: string[] = []
  const days = rows.map((row) => {
    const date = row.localDate.toISOString().slice(0, 10)
    const summary =
      row.summaryFetchedAt && row.summaryFetchedAt <= now && row.sourceTimezone === timezone
    const sleep =
      row.sleepFetchedAt && row.sleepFetchedAt <= now && row.sleepSourceTimezone === timezone
    if (summary && sleep) checked.push(date)
    const metric = (
      value: number | null,
      unit: EvidenceMetric['unit'],
      at: Date | null,
    ): EvidenceMetric => ({
      value,
      unit,
      provenance: {
        source: 'GARMIN',
        observedAt: (at ?? now).toISOString(),
        period: { startDate: date, endDate: date },
        quality: value === null ? 'unavailable' : 'recorded',
      },
    })
    return {
      date,
      restingHr: metric(
        summary && row.restingHrBpm !== null ? row.restingHrBpm : null,
        'bpm',
        row.summaryFetchedAt,
      ),
      hrv: metric(
        summary && meaningfulHrv && row.hrvMs !== null ? Number(row.hrvMs) : null,
        'ms',
        row.summaryFetchedAt,
      ),
      sleepDuration: metric(
        sleep && row.sleepDurationMs !== null ? Number(row.sleepDurationMs) / 1000 : null,
        's',
        row.sleepFetchedAt,
      ),
    }
  })
  const timestamps = rows
    .flatMap((r) => [r.summaryFetchedAt, r.sleepFetchedAt])
    .filter((d): d is Date => d !== null && d <= now)
  const recovery = {
    consentSelected: true,
    timezone,
    days,
    coverage: {
      provider: 'GARMIN',
      timezone,
      window: period,
      label: 'recorded history only',
      status:
        checked.length === 28 && !failedDates.length
          ? 'sufficient'
          : rows.length || failedDates.length
            ? 'partial'
            : 'unknown',
      lastManualSyncAt:
        timestamps
          .map((d) => d.toISOString())
          .sort()
          .at(-1) ?? null,
      completeWindows: compress(checked),
      failedWindows: compress(failedDates),
      unfetchedWindows: compress(
        Array.from({ length: 28 }, (_, i) => addHealthDays(startDate, i)).filter(
          (d) => !checked.includes(d) && !failedDates.includes(d),
        ),
      ),
    },
  }
  return trainingContextSchema.shape.recoveryContext.parse(recovery)
}
