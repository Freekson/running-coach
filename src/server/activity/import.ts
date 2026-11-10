import 'server-only'

import { randomUUID } from 'node:crypto'
import { Prisma, type Activity } from '@prisma/client'
import { z } from 'zod'
import {
  canonicalActivitySchema,
  isCrossProviderDuplicateCandidate,
  type CanonicalActivity,
} from '@/server/activity/normalization'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'

export class InvalidActivityImportError extends Error {
  constructor() {
    super('Invalid activity import')
  }
}

const uuidSchema = z.uuid()
const listLimitSchema = z.number().int().min(1).max(50)
const cursorSchema = z.strictObject({
  version: z.literal(2),
  userId: uuidSchema,
  listStartedAt: z.iso.datetime(),
  id: uuidSchema,
})
const encodedCursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/)
export type LapImportStatus = 'IMPORTED' | 'RETAINED' | 'UNAVAILABLE'
const FIT_REFRESH_MS = 24 * 60 * 60 * 1000

function encodeActivityCursor(userId: string, row: { listStartedAt: Date; id: string }) {
  return Buffer.from(
    JSON.stringify({
      version: 2,
      userId,
      listStartedAt: row.listStartedAt.toISOString(),
      id: row.id,
    }),
  ).toString('base64url')
}

function decodeActivityCursor(cursor: string, userId: string) {
  if (!encodedCursorSchema.safeParse(cursor).success) throw new InvalidActivityImportError()
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString()))
    if (!parsed.success || parsed.data.userId !== userId) throw new InvalidActivityImportError()
    if (
      Buffer.from(JSON.stringify(parsed.data)).toString('base64url') !== cursor ||
      !Number.isFinite(new Date(parsed.data.listStartedAt).getTime())
    )
      throw new InvalidActivityImportError()
    return { listStartedAt: new Date(parsed.data.listStartedAt), id: parsed.data.id }
  } catch {
    throw new InvalidActivityImportError()
  }
}

function safeMilliseconds(value: number | null): bigint | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || value < 0) throw new InvalidActivityImportError()
  return BigInt(value)
}

function activityFields(
  activity: CanonicalActivity,
  lapImportStatus: LapImportStatus,
  sourceObservedAt: Date,
) {
  return {
    externalActivityUuid: activity.source.externalActivityUuid,
    sourceRecordType: activity.source.recordType,
    sportType: activity.sportType,
    sourceSportType: activity.sourceSportType,
    startedAt: new Date(activity.startedAt),
    sourceTimezone: activity.sourceTimezone,
    distanceMeters: activity.distanceMeters,
    totalMs: safeMilliseconds(activity.totalMs),
    elapsedMs: safeMilliseconds(activity.elapsedMs),
    movingMs: safeMilliseconds(activity.movingMs),
    avgSpeedMps: activity.avgSpeedMps,
    avgHrBpm: activity.avgHrBpm,
    maxHrBpm: activity.maxHrBpm,
    cadence: activity.cadenceStepsPerMinute,
    elevationGainMeters: activity.elevationGainMeters,
    elevationLossMeters: activity.elevationLossMeters,
    gpsAssetRef: activity.gpsAssetRef,
    lapImportStatus,
    sourceObservedAt,
  }
}

function sameDecimal(stored: Prisma.Decimal | null, incoming: number | null, scale: number) {
  return stored === null
    ? incoming === null
    : incoming !== null && stored.equals(new Prisma.Decimal(incoming).toDecimalPlaces(scale))
}

function sameActivitySummary(existing: Activity, fields: ReturnType<typeof activityFields>) {
  return (
    existing.externalActivityUuid === fields.externalActivityUuid &&
    existing.sourceRecordType === fields.sourceRecordType &&
    existing.sportType === fields.sportType &&
    existing.sourceSportType === fields.sourceSportType &&
    existing.startedAt.getTime() === fields.startedAt.getTime() &&
    existing.sourceTimezone === fields.sourceTimezone &&
    sameDecimal(existing.distanceMeters, fields.distanceMeters, 3) &&
    existing.totalMs === fields.totalMs &&
    existing.elapsedMs === fields.elapsedMs &&
    existing.movingMs === fields.movingMs &&
    sameDecimal(existing.avgSpeedMps, fields.avgSpeedMps, 6) &&
    existing.avgHrBpm === fields.avgHrBpm &&
    existing.maxHrBpm === fields.maxHrBpm &&
    sameDecimal(existing.cadence, fields.cadence, 2) &&
    sameDecimal(existing.elevationGainMeters, fields.elevationGainMeters, 2) &&
    sameDecimal(existing.elevationLossMeters, fields.elevationLossMeters, 2) &&
    existing.gpsAssetRef === fields.gpsAssetRef
  )
}

/** Skip FIT when unchanged laps are retained or FIT was checked recently. */
export async function canSkipFitDownload(
  owner: OwnerContext,
  untrustedActivity: unknown,
  options: { refresh?: boolean; observedAt?: Date; garminAccountId?: string } = {},
): Promise<boolean> {
  const userId = ownerId(owner)
  const activity = canonicalActivitySchema.parse(untrustedActivity)
  if (activity.source.userId !== userId || !activity.source.externalActivityId)
    throw new InvalidActivityImportError()
  const prisma = await getPrismaClient()
  const existing = await prisma.activity.findUnique({
    where: {
      userId_sourceProvider_externalActivityId_garminAccountId: {
        userId,
        sourceProvider: activity.source.provider,
        externalActivityId: activity.source.externalActivityId,
        garminAccountId: options.garminAccountId ?? 'LEGACY_UNVERIFIED',
      },
    },
  })
  const observedAt = options.observedAt ?? new Date()
  if (options.refresh && !Number.isFinite(observedAt.getTime()))
    throw new InvalidActivityImportError()
  const fitAge = existing?.fitCheckedAt
    ? observedAt.getTime() - existing.fitCheckedAt.getTime()
    : null
  const fitRecentlyChecked = fitAge !== null && fitAge >= 0 && fitAge < FIT_REFRESH_MS
  return Boolean(
    existing &&
    sameActivitySummary(existing, activityFields(activity, 'UNAVAILABLE', observedAt)) &&
    (fitRecentlyChecked ||
      (!options.refresh &&
        (existing.lapImportStatus === 'IMPORTED' || existing.lapImportStatus === 'RETAINED'))),
  )
}

function lapStatus(value: string): LapImportStatus {
  if (value === 'IMPORTED' || value === 'RETAINED' || value === 'UNAVAILABLE') return value
  throw new InvalidActivityImportError()
}

function candidateShape(row: Activity): CanonicalActivity | null {
  const parsed = canonicalActivitySchema.safeParse({
    source: {
      userId: row.userId,
      provider: row.sourceProvider,
      externalActivityId: row.externalActivityId,
      externalActivityUuid: row.externalActivityUuid,
      recordType: row.sourceRecordType,
    },
    sportType: row.sportType,
    sourceSportType: row.sourceSportType,
    startedAt: row.startedAt.toISOString(),
    sourceTimezone: row.sourceTimezone,
    gpsAssetRef: row.gpsAssetRef,
    distanceMeters: row.distanceMeters?.toNumber() ?? null,
    totalMs: row.totalMs === null ? null : Number(row.totalMs),
    elapsedMs: row.elapsedMs === null ? null : Number(row.elapsedMs),
    movingMs: row.movingMs === null ? null : Number(row.movingMs),
    avgSpeedMps: row.avgSpeedMps?.toNumber() ?? null,
    avgHrBpm: row.avgHrBpm,
    maxHrBpm: row.maxHrBpm,
    cadenceStepsPerMinute: row.cadence?.toNumber() ?? null,
    elevationGainMeters: row.elevationGainMeters?.toNumber() ?? null,
    elevationLossMeters: row.elevationLossMeters?.toNumber() ?? null,
    laps: null,
  })
  return parsed.success ? parsed.data : null
}

function lapRows(activity: CanonicalActivity, userId: string, activityId: string) {
  return (activity.laps ?? []).map((lap) => ({
    userId,
    activityId,
    lapIndex: lap.lapIndex,
    sourceRecordType: lap.sourceRecordType,
    startedAt: lap.startedAt === null ? null : new Date(lap.startedAt),
    distanceMeters: lap.distanceMeters,
    elapsedMs: safeMilliseconds(lap.elapsedMs),
    movingMs: safeMilliseconds(lap.movingMs),
    avgHrBpm: lap.avgHrBpm,
    avgSpeedMps: lap.avgSpeedMps,
    cadenceStepsPerMinute: lap.cadenceStepsPerMinute,
  }))
}

function lapSourceKey(lap: { startedAt: Date | null; sourceRecordType: string }) {
  return lap.startedAt === null ? null : `${lap.sourceRecordType}|${lap.startedAt.toISOString()}`
}

function stableLapRows(
  laps: ReturnType<typeof lapRows>,
  previous: { id: string; startedAt: Date | null; sourceRecordType: string }[],
) {
  const priorIds = new Map<string, string | null>()
  for (const lap of previous) {
    const key = lapSourceKey(lap)
    if (key !== null) priorIds.set(key, priorIds.has(key) ? null : lap.id)
  }
  const incomingCounts = new Map<string, number>()
  for (const lap of laps) {
    const key = lapSourceKey(lap)
    if (key !== null) incomingCounts.set(key, (incomingCounts.get(key) ?? 0) + 1)
  }
  return laps.map((lap) => {
    const key = lapSourceKey(lap)
    const previousId = key !== null && incomingCounts.get(key) === 1 ? priorIds.get(key) : null
    return { ...lap, id: previousId || randomUUID() }
  })
}

/** The network fetch is complete before this transaction begins. Every child write is owner-scoped. */
export async function importCanonicalActivity(
  owner: OwnerContext,
  untrustedActivity: unknown,
  options: {
    sourceObservedAt?: Date
    fitCheckedAt?: Date
    garminAccountId?: string
    beforeWrite?: (tx: Prisma.TransactionClient) => Promise<void>
  } = {},
): Promise<{ id: string; lapImportStatus: LapImportStatus }> {
  const userId = ownerId(owner)
  const activity = canonicalActivitySchema.parse(untrustedActivity)
  const externalActivityId = activity.source.externalActivityId
  if (activity.source.userId !== userId || !externalActivityId)
    throw new InvalidActivityImportError()
  const sourceObservedAt = options.sourceObservedAt ?? new Date()
  if (!(sourceObservedAt instanceof Date) || !Number.isFinite(sourceObservedAt.getTime()))
    throw new InvalidActivityImportError()
  if (
    options.fitCheckedAt !== undefined &&
    (!(options.fitCheckedAt instanceof Date) || !Number.isFinite(options.fitCheckedAt.getTime()))
  )
    throw new InvalidActivityImportError()
  const identity = {
    userId,
    sourceProvider: activity.source.provider,
    externalActivityId,
    garminAccountId: options.garminAccountId ?? 'LEGACY_UNVERIFIED',
  }
  if (activity.source.provider === 'GARMIN' && options.beforeWrite && !options.garminAccountId)
    throw new InvalidActivityImportError()
  const prisma = await getPrismaClient()
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          await options.beforeWrite?.(tx)
          const existing = await tx.activity.findUnique({
            where: { userId_sourceProvider_externalActivityId_garminAccountId: identity },
          })
          if (
            existing?.sourceObservedAt &&
            existing.sourceObservedAt.getTime() > sourceObservedAt.getTime()
          )
            return { id: existing.id, lapImportStatus: lapStatus(existing.lapImportStatus) }
          const comparison = activityFields(activity, 'UNAVAILABLE', sourceObservedAt)
          const summaryMatches = existing !== null && sameActivitySummary(existing, comparison)
          const retainLaps =
            activity.laps === null &&
            summaryMatches &&
            (existing?.lapImportStatus === 'IMPORTED' || existing?.lapImportStatus === 'RETAINED')
          const lapImportStatus: LapImportStatus =
            activity.laps !== null ? 'IMPORTED' : retainLaps ? 'RETAINED' : 'UNAVAILABLE'
          const fields = { ...comparison, lapImportStatus }
          const saved = await tx.activity.upsert({
            where: {
              userId_sourceProvider_externalActivityId_garminAccountId: identity,
            },
            create: {
              ...identity,
              ...fields,
              fitCheckedAt: options.fitCheckedAt,
              listStartedAt: new Date(activity.startedAt),
            },
            update: {
              ...fields,
              fitCheckedAt: options.fitCheckedAt ?? (summaryMatches ? undefined : null),
            },
            select: { id: true },
          })
          if (!retainLaps) {
            const laps = lapRows(activity, userId, saved.id)
            const previous = laps.length
              ? await tx.activityLap.findMany({
                  where: { userId, activityId: saved.id },
                  select: { id: true, startedAt: true, sourceRecordType: true },
                })
              : []
            await tx.activityLap.deleteMany({ where: { userId, activityId: saved.id } })
            if (laps.length)
              await tx.activityLap.createMany({
                data: stableLapRows(laps, previous),
              })
          }

          await tx.activityDuplicateCandidate.deleteMany({
            where: {
              userId,
              OR: [{ firstActivityId: saved.id }, { secondActivityId: saved.id }],
            },
          })
          if (activity.sportType !== 'OTHER' && activity.distanceMeters !== null) {
            const near = await tx.activity.findMany({
              where: {
                userId,
                id: { not: saved.id },
                sourceProvider: { not: activity.source.provider },
                sportType: activity.sportType,
                startedAt: {
                  gte: new Date(Date.parse(activity.startedAt) - 120_000),
                  lte: new Date(Date.parse(activity.startedAt) + 120_000),
                },
              },
            })
            for (const row of near) {
              const other = candidateShape(row)
              if (!other || !isCrossProviderDuplicateCandidate(activity, other)) continue
              const [firstActivityId, secondActivityId] =
                saved.id < row.id ? [saved.id, row.id] : [row.id, saved.id]
              await tx.activityDuplicateCandidate.upsert({
                where: { firstActivityId_secondActivityId: { firstActivityId, secondActivityId } },
                create: { userId, firstActivityId, secondActivityId },
                update: {},
              })
            }
          }
          return { id: saved.id, lapImportStatus }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034' &&
        attempt < 2
      )
        continue
      throw error
    }
  }
  throw new Error('Activity import retry exhausted')
}

const summarySelect = {
  id: true,
  sourceProvider: true,
  externalActivityId: true,
  externalActivityUuid: true,
  sourceRecordType: true,
  sportType: true,
  sourceSportType: true,
  startedAt: true,
  listStartedAt: true,
  sourceTimezone: true,
  distanceMeters: true,
  totalMs: true,
  elapsedMs: true,
  movingMs: true,
  avgSpeedMps: true,
  avgHrBpm: true,
  maxHrBpm: true,
  cadence: true,
  elevationGainMeters: true,
  elevationLossMeters: true,
  lapImportStatus: true,
  duplicateCandidatesAsFirst: { select: { secondActivityId: true } },
  duplicateCandidatesAsSecond: { select: { firstActivityId: true } },
} as const

function publicSummary(row: Prisma.ActivityGetPayload<{ select: typeof summarySelect }>) {
  return {
    id: row.id,
    provider: row.sourceProvider,
    externalActivityId: row.externalActivityId,
    externalActivityUuid: row.externalActivityUuid,
    sourceRecordType: row.sourceRecordType,
    sportType: row.sportType,
    sourceSportType: row.sourceSportType,
    startedAt: row.startedAt.toISOString(),
    sourceTimezone: row.sourceTimezone,
    distanceMeters: row.distanceMeters?.toNumber() ?? null,
    totalMs: row.totalMs === null ? null : Number(row.totalMs),
    elapsedMs: row.elapsedMs === null ? null : Number(row.elapsedMs),
    movingMs: row.movingMs === null ? null : Number(row.movingMs),
    avgSpeedMps: row.avgSpeedMps?.toNumber() ?? null,
    avgHrBpm: row.avgHrBpm,
    maxHrBpm: row.maxHrBpm,
    cadenceStepsPerMinute: row.cadence?.toNumber() ?? null,
    elevationGainMeters: row.elevationGainMeters?.toNumber() ?? null,
    elevationLossMeters: row.elevationLossMeters?.toNumber() ?? null,
    lapImportStatus: row.lapImportStatus,
    duplicateCandidateIds: [
      ...row.duplicateCandidatesAsFirst.map((candidate) => candidate.secondActivityId),
      ...row.duplicateCandidatesAsSecond.map((candidate) => candidate.firstActivityId),
    ].sort(),
  }
}

export async function listActivities(owner: OwnerContext, limit: number, cursor?: string) {
  const userId = ownerId(owner)
  listLimitSchema.parse(limit)
  const boundary = cursor === undefined ? null : decodeActivityCursor(cursor, userId)
  const prisma = await getPrismaClient()
  const garmin = await prisma.integrationConnection.findUnique({
    where: { userId_provider: { userId, provider: 'GARMIN' } },
    select: { externalAccountId: true },
  })
  const rows = await prisma.activity.findMany({
    where: {
      userId,
      OR: [
        { sourceProvider: { not: 'GARMIN' } },
        ...(garmin?.externalAccountId
          ? [{ sourceProvider: 'GARMIN' as const, garminAccountId: garmin.externalAccountId }]
          : []),
      ],
      ...(boundary
        ? {
            AND: [
              {
                OR: [
                  { listStartedAt: { lt: boundary.listStartedAt } },
                  { listStartedAt: boundary.listStartedAt, id: { lt: boundary.id } },
                ],
              },
            ],
          }
        : {}),
    },
    orderBy: [{ listStartedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: summarySelect,
  })
  const page = rows.slice(0, limit)
  return {
    items: page.map(publicSummary),
    nextCursor:
      rows.length > limit && page.length > 0
        ? encodeActivityCursor(userId, page[page.length - 1])
        : null,
  }
}

export async function getActivity(owner: OwnerContext, id: string) {
  const userId = ownerId(owner)
  uuidSchema.parse(id)
  const prisma = await getPrismaClient()
  const garmin = await prisma.integrationConnection.findUnique({
    where: { userId_provider: { userId, provider: 'GARMIN' } },
    select: { externalAccountId: true },
  })
  const row = await prisma.activity.findFirst({
    where: {
      userId,
      id,
      OR: [
        { sourceProvider: { not: 'GARMIN' } },
        ...(garmin?.externalAccountId
          ? [{ sourceProvider: 'GARMIN' as const, garminAccountId: garmin.externalAccountId }]
          : []),
      ],
    },
    select: {
      ...summarySelect,
      laps: {
        orderBy: { lapIndex: 'asc' },
        select: {
          lapIndex: true,
          sourceRecordType: true,
          startedAt: true,
          distanceMeters: true,
          elapsedMs: true,
          movingMs: true,
          avgHrBpm: true,
          avgSpeedMps: true,
          cadenceStepsPerMinute: true,
        },
      },
    },
  })
  if (!row) return null
  return {
    ...publicSummary(row),
    laps: row.laps.map((lap) => ({
      lapIndex: lap.lapIndex,
      sourceRecordType: lap.sourceRecordType,
      startedAt: lap.startedAt?.toISOString() ?? null,
      distanceMeters: lap.distanceMeters?.toNumber() ?? null,
      elapsedMs: lap.elapsedMs === null ? null : Number(lap.elapsedMs),
      movingMs: lap.movingMs === null ? null : Number(lap.movingMs),
      avgHrBpm: lap.avgHrBpm,
      avgSpeedMps: lap.avgSpeedMps?.toNumber() ?? null,
      cadenceStepsPerMinute: lap.cadenceStepsPerMinute?.toNumber() ?? null,
    })),
  }
}
