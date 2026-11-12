import 'server-only'
import { Prisma } from '@prisma/client'
import {
  activityHistoryQuerySchema,
  activityTimezoneSchema,
  type ActivityHistoryPage,
  type ActivityHistoryRow,
} from '@/lib/activity-history'
import { addHealthDays, healthLocalDay } from '@/lib/health-history'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import { activityReadScope } from './visibility'

function validTimezone(value: string | null | undefined): string {
  try {
    if (value) {
      new Intl.DateTimeFormat('en-US', { timeZone: value })
      return value
    }
  } catch {}
  return 'UTC'
}

/** First instant of a calendar day, including DST changes and skipped local midnights. */
export function activityDayBoundary(date: string, timezone: string): Date {
  const midnight = Date.parse(`${date}T00:00:00Z`)
  let low = midnight - 36 * 3_600_000
  let high = midnight + 36 * 3_600_000
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (healthLocalDay(new Date(middle).toISOString(), timezone) < date) low = middle
    else high = middle
  }
  return new Date(high)
}

const select = {
  id: true,
  activityTitle: true,
  sportType: true,
  sourceSportType: true,
  sourceProvider: true,
  startedAt: true,
  distanceMeters: true,
  totalMs: true,
  movingMs: true,
  elapsedMs: true,
  avgSpeedMps: true,
  avgHrBpm: true,
} satisfies Prisma.ActivitySelect

export function activityHistoryRow(
  row: Prisma.ActivityGetPayload<{ select: typeof select }>,
): ActivityHistoryRow {
  const milliseconds = (value: bigint | null) =>
    value !== null && value >= BigInt(0) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : null
  return {
    id: row.id,
    title: row.activityTitle,
    sport: row.sportType,
    sourceSport: row.sourceSportType,
    provider: row.sourceProvider,
    startedAt: row.startedAt.toISOString(),
    distanceMeters: row.distanceMeters?.toNumber() ?? null,
    timerMs: milliseconds(row.totalMs),
    movingMs: milliseconds(row.movingMs),
    elapsedMs: milliseconds(row.elapsedMs),
    avgSpeedMps: row.avgSpeedMps?.toNumber() ?? null,
    avgHrBpm: row.avgHrBpm,
  }
}

export async function getActivityHistory(
  owner: OwnerContext,
  input: unknown,
  options: { now?: Date; timezone?: string } = {},
): Promise<ActivityHistoryPage> {
  const userId = ownerId(owner)
  const query = activityHistoryQuerySchema.parse(input)
  const prisma = await getPrismaClient()
  const [scope, profile] = await Promise.all([
    activityReadScope(owner),
    prisma.athleteProfile.findUnique({ where: { userId }, select: { preferredTimezone: true } }),
  ])
  const browserZone = activityTimezoneSchema.safeParse(options.timezone)
  const timezone = browserZone.success
    ? browserZone.data
    : validTimezone(profile?.preferredTimezone)
  const now = options.now ?? new Date()
  const today = healthLocalDay(now.toISOString(), timezone)
  const from =
    query.range === 'custom'
      ? query.from
      : query.range === 'all'
        ? ''
        : addHealthDays(today, 1 - Number(query.range))
  const to = query.range === 'custom' ? query.to : query.range === 'all' ? '' : today
  const where: Prisma.ActivityWhereInput = {
    AND: [
      scope,
      {
        ...(query.q
          ? { activityTitle: { contains: query.q.replace(/[%_\\]/g, '\\$&'), mode: 'insensitive' } }
          : {}),
        ...(query.sport ? { sportType: query.sport } : {}),
        ...(query.provider ? { sourceProvider: query.provider } : {}),
        ...(from || to
          ? {
              startedAt: {
                ...(from ? { gte: activityDayBoundary(from, timezone) } : {}),
                ...(to ? { lt: activityDayBoundary(addHealthDays(to, 1), timezone) } : {}),
              },
            }
          : {}),
        ...(query.minDistance === 'ultra'
          ? { distanceMeters: { gt: 42195 } }
          : query.minDistance !== ''
            ? { distanceMeters: { gte: Number(query.minDistance) * 1000 } }
            : {}),
      },
    ],
  }
  const orderBy: Prisma.ActivityOrderByWithRelationInput[] =
    query.sort === 'distance'
      ? [{ distanceMeters: { sort: 'desc', nulls: 'last' } }, { startedAt: 'desc' }, { id: 'desc' }]
      : [
          { startedAt: query.sort === 'oldest' ? 'asc' : 'desc' },
          { id: query.sort === 'oldest' ? 'asc' : 'desc' },
        ]
  return prisma.$transaction(
    async (tx) => {
      const [total, importedCount, sports, providers, importedCursor, activityDates] =
        await Promise.all([
          tx.activity.count({ where }),
          tx.activity.count({ where: scope }),
          tx.activity.groupBy({ by: ['sportType'], where: scope, orderBy: { sportType: 'asc' } }),
          tx.activity.groupBy({
            by: ['sourceProvider'],
            where: scope,
            orderBy: { sourceProvider: 'asc' },
          }),
          tx.syncCursor.findFirst({
            where: { userId, dataType: 'GARMIN_IMPORT_ACTIVITIES' },
            select: { lastSyncedAt: true },
          }),
          tx.activity.aggregate({
            where: scope,
            _min: { startedAt: true },
            _max: { importedAt: true },
          }),
        ])
      const earliestDay = activityDates._min.startedAt
        ? healthLocalDay(activityDates._min.startedAt.toISOString(), timezone)
        : '2020-01-01'
      const pageCount = Math.max(1, Math.ceil(total / query.pageSize))
      const page = Math.min(query.page, pageCount)
      const rows = await tx.activity.findMany({
        where,
        orderBy,
        skip: (page - 1) * query.pageSize,
        take: query.pageSize,
        select,
      })
      return {
        items: rows.map(activityHistoryRow),
        total,
        importedCount,
        page,
        pageCount,
        pageSize: query.pageSize,
        sports: sports.map((entry) => entry.sportType),
        providers: providers.map((entry) => entry.sourceProvider),
        timezone,
        dateBounds: { min: earliestDay < today ? earliestDay : today, max: today },
        imported: importedCount > 0 || importedCursor?.lastSyncedAt != null,
        savedAt:
          (activityDates._max.importedAt ?? importedCursor?.lastSyncedAt)?.toISOString() ?? null,
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  )
}
