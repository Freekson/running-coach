import 'server-only'

import type { HealthSnapshotData } from '@/lib/health-snapshot'
import type { DailyHealthObservation } from './normalization'
import { dailyHealthObservationSchema } from './normalization'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import { assertProviderApiKeySnapshotCurrent } from '@/server/provider/vault'
import type { HealthTimezoneBasis } from '@/lib/health-history'

function dbDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`)
}

export async function getHealthPreferredTimezone(owner: OwnerContext): Promise<string | null> {
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  const profile = await prisma.athleteProfile.findUnique({
    where: { userId },
    select: { preferredTimezone: true },
  })
  return profile?.preferredTimezone ?? null
}

async function linkedGarminAccountId(userId: string) {
  const prisma = await getPrismaClient()
  const connection = await prisma.integrationConnection.findUnique({
    where: { userId_provider: { userId, provider: 'GARMIN' } },
    select: { externalAccountId: true },
  })
  return connection?.externalAccountId ?? null
}

/** Save one verified source independently so a missing sleep response cannot erase resting HR. */
export async function saveGarminHealthObservation(
  owner: OwnerContext,
  kind: 'summary' | 'sleep',
  localDate: string,
  sourceTimezone: string,
  observation: DailyHealthObservation | null,
  credentialNonce: Uint8Array,
  garminAccountId: string,
  fetchedAt: Date,
  attemptSequence: bigint,
  timezoneBasis: HealthTimezoneBasis = 'REQUEST_INFERRED',
): Promise<void> {
  const userId = ownerId(owner)
  const nonceBytes = Uint8Array.from(credentialNonce)
  if (observation) {
    const parsed = dailyHealthObservationSchema.parse(observation)
    if (
      parsed.userId !== userId ||
      parsed.sourceProvider !== 'GARMIN' ||
      parsed.localDate !== localDate ||
      parsed.sourceTimezone !== sourceTimezone ||
      parsed.sourceRecordType !== (kind === 'summary' ? 'API_DAILY_SUMMARY' : 'API_SLEEP')
    )
      throw new Error('Health observation identity mismatch')
  }
  const prisma = await getPrismaClient()
  await prisma.$transaction(async (tx) => {
    await assertProviderApiKeySnapshotCurrent(tx, owner, 'GARMIN', credentialNonce, garminAccountId)
    const key = {
      userId,
      sourceProvider: 'GARMIN' as const,
      localDate: dbDate(localDate),
      garminAccountId,
    }
    const fields =
      kind === 'summary'
        ? {
            ...(observation?.restingHrBpm != null
              ? {
                  restingHrBpm: observation.restingHrBpm,
                  sourceTimezone,
                  sourceTimezoneBasis: timezoneBasis,
                }
              : {}),
            summaryFetchedAt: fetchedAt,
            summaryAttemptSequence: attemptSequence,
          }
        : {
            ...(observation?.sleepDurationMs != null
              ? {
                  sleepDurationMs: BigInt(observation.sleepDurationMs),
                  sleepStartedAt: observation.sleepStartedAt
                    ? new Date(observation.sleepStartedAt)
                    : null,
                  sleepEndedAt: observation.sleepEndedAt
                    ? new Date(observation.sleepEndedAt)
                    : null,
                  sleepLightMs:
                    observation.sleepLightMs == null ? null : BigInt(observation.sleepLightMs),
                  sleepDeepMs:
                    observation.sleepDeepMs == null ? null : BigInt(observation.sleepDeepMs),
                  sleepRemMs:
                    observation.sleepRemMs == null ? null : BigInt(observation.sleepRemMs),
                  sleepAwakeMs:
                    observation.sleepAwakeMs == null ? null : BigInt(observation.sleepAwakeMs),
                  sleepScore: observation.sleepScore ?? null,
                  sleepSourceTimezone: sourceTimezone,
                  sleepTimezoneBasis: timezoneBasis,
                }
              : {}),
            sleepFetchedAt: fetchedAt,
            sleepAttemptSequence: attemptSequence,
          }
    await tx.dailyHealthMetric.createMany({
      data: {
        ...key,
        sourceTimezone,
        credentialNonce: nonceBytes,
        ...(kind === 'summary'
          ? { sourceTimezoneBasis: timezoneBasis }
          : { sleepSourceTimezone: sourceTimezone, sleepTimezoneBasis: timezoneBasis }),
        ...fields,
      },
      skipDuplicates: true,
    })
    await tx.dailyHealthMetric.updateMany({
      where: {
        ...key,
        OR:
          kind === 'summary'
            ? [
                { summaryAttemptSequence: null },
                { summaryAttemptSequence: { lte: attemptSequence } },
              ]
            : [{ sleepAttemptSequence: null }, { sleepAttemptSequence: { lte: attemptSequence } }],
      },
      data: { ...fields, credentialNonce: nonceBytes },
    })
  })
}

/** Owner-scoped selector for Settings and the future dashboard. Each metric keeps its own date. */
export async function getHealthSnapshot(owner: OwnerContext): Promise<HealthSnapshotData> {
  const userId = ownerId(owner)
  const garminAccountId = await linkedGarminAccountId(userId)
  if (!garminAccountId)
    return {
      restingHr: null,
      sleep: null,
      restingHrChecked: false,
      sleepChecked: false,
      lastUpdatedAt: null,
    }
  const prisma = await getPrismaClient()
  const [hr, sleep, lastSummary, lastSleep] = await Promise.all([
    prisma.dailyHealthMetric.findFirst({
      where: {
        userId,
        sourceProvider: 'GARMIN',
        garminAccountId,
        restingHrBpm: { not: null },
        summaryFetchedAt: { not: null },
      },
      orderBy: { localDate: 'desc' },
    }),
    prisma.dailyHealthMetric.findFirst({
      where: {
        userId,
        sourceProvider: 'GARMIN',
        garminAccountId,
        sleepDurationMs: { not: null },
        sleepFetchedAt: { not: null },
      },
      orderBy: { localDate: 'desc' },
    }),
    prisma.dailyHealthMetric.findFirst({
      where: { userId, sourceProvider: 'GARMIN', garminAccountId, summaryFetchedAt: { not: null } },
      orderBy: { summaryFetchedAt: 'desc' },
      select: { summaryFetchedAt: true },
    }),
    prisma.dailyHealthMetric.findFirst({
      where: { userId, sourceProvider: 'GARMIN', garminAccountId, sleepFetchedAt: { not: null } },
      orderBy: { sleepFetchedAt: 'desc' },
      select: { sleepFetchedAt: true },
    }),
  ])
  const lastFetchedAt = [lastSummary?.summaryFetchedAt, lastSleep?.sleepFetchedAt]
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0]
  return {
    restingHr:
      hr?.restingHrBpm == null || !hr.summaryFetchedAt
        ? null
        : {
            value: hr.restingHrBpm,
            date: hr.localDate.toISOString().slice(0, 10),
            timezone: hr.sourceTimezone,
            fetchedAt: hr.summaryFetchedAt.toISOString(),
          },
    sleep:
      sleep?.sleepDurationMs == null || !sleep.sleepFetchedAt
        ? null
        : {
            value: Number(sleep.sleepDurationMs),
            date: sleep.localDate.toISOString().slice(0, 10),
            timezone: sleep.sleepSourceTimezone ?? sleep.sourceTimezone,
            fetchedAt: sleep.sleepFetchedAt.toISOString(),
          },
    restingHrChecked: Boolean(lastSummary?.summaryFetchedAt),
    sleepChecked: Boolean(lastSleep?.sleepFetchedAt),
    lastUpdatedAt: lastFetchedAt?.toISOString() ?? null,
  }
}

export async function listHealthHistory(owner: OwnerContext, limit = 31) {
  const userId = ownerId(owner)
  const garminAccountId = await linkedGarminAccountId(userId)
  if (!garminAccountId) return []
  const prisma = await getPrismaClient()
  return prisma.dailyHealthMetric.findMany({
    where: { userId, sourceProvider: 'GARMIN', garminAccountId },
    orderBy: { localDate: 'desc' },
    take: Math.min(Math.max(limit, 1), 31),
  })
}

/** Verified account history remains visible after key rotation or disconnect. */
export async function getHealthTrendRows(
  owner: OwnerContext,
  startDate: string | null,
  endDate: string,
) {
  const userId = ownerId(owner)
  const garminAccountId = await linkedGarminAccountId(userId)
  if (!garminAccountId) return []
  const prisma = await getPrismaClient()
  const rows = await prisma.dailyHealthMetric.findMany({
    where: {
      userId,
      sourceProvider: 'GARMIN',
      garminAccountId,
      localDate: { ...(startDate ? { gte: dbDate(startDate) } : {}), lte: dbDate(endDate) },
    },
    orderBy: { localDate: 'asc' },
    select: {
      localDate: true,
      restingHrBpm: true,
      sleepDurationMs: true,
      sleepStartedAt: true,
      sleepEndedAt: true,
      sleepLightMs: true,
      sleepDeepMs: true,
      sleepRemMs: true,
      sleepAwakeMs: true,
      sleepScore: true,
      sleepSourceTimezone: true,
      sourceTimezone: true,
      summaryFetchedAt: true,
      sleepFetchedAt: true,
    },
  })
  return rows.map((row) => ({
    date: row.localDate.toISOString().slice(0, 10),
    restingHrBpm: row.summaryFetchedAt ? row.restingHrBpm : null,
    sleepDurationMs:
      row.sleepFetchedAt && row.sleepDurationMs !== null ? Number(row.sleepDurationMs) : null,
    sleepStartedAt: row.sleepFetchedAt ? (row.sleepStartedAt?.toISOString() ?? null) : null,
    sleepEndedAt: row.sleepFetchedAt ? (row.sleepEndedAt?.toISOString() ?? null) : null,
    sleepTimezone: row.sleepFetchedAt ? (row.sleepSourceTimezone ?? row.sourceTimezone) : null,
    sleepScore: row.sleepFetchedAt ? row.sleepScore : null,
    sleepLightMs: row.sleepFetchedAt
      ? row.sleepLightMs == null
        ? null
        : Number(row.sleepLightMs)
      : null,
    sleepDeepMs: row.sleepFetchedAt
      ? row.sleepDeepMs == null
        ? null
        : Number(row.sleepDeepMs)
      : null,
    sleepRemMs: row.sleepFetchedAt
      ? row.sleepRemMs == null
        ? null
        : Number(row.sleepRemMs)
      : null,
    sleepAwakeMs: row.sleepFetchedAt
      ? row.sleepAwakeMs == null
        ? null
        : Number(row.sleepAwakeMs)
      : null,
    summaryChecked: row.summaryFetchedAt !== null,
    sleepChecked: row.sleepFetchedAt !== null,
  }))
}

export async function getHealthSourceCoverage(
  owner: OwnerContext,
  date: string,
  garminAccountId: string,
) {
  const prisma = await getPrismaClient()
  return prisma.dailyHealthMetric.findUnique({
    where: {
      userId_sourceProvider_localDate_garminAccountId: {
        userId: ownerId(owner),
        sourceProvider: 'GARMIN',
        localDate: dbDate(date),
        garminAccountId,
      },
    },
    select: { summaryFetchedAt: true, sleepFetchedAt: true },
  })
}
