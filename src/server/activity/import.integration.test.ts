import { testGarminAccountId } from '@/server/garmin/test-identity'
import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'

vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))

import { getOwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import {
  assertProviderApiKeySnapshotCurrent,
  disconnectProvider,
  readProviderApiKeySnapshot,
  saveProviderApiKey,
} from '@/server/provider/vault'
import { CredentialUnavailableError } from '@/server/provider/credential-crypto'
import { canonicalActivitySchema } from './normalization'
import {
  getActivity,
  canSkipFitDownload as canSkipFitActivity,
  importCanonicalActivity as importActivity,
  listActivities,
} from './import'

const importCanonicalActivity: typeof importActivity = (owner, activity, options) =>
  importActivity(owner, activity, { ...options, garminAccountId: testGarminAccountId(owner) })

const canSkipFitDownload: typeof canSkipFitActivity = (owner, activity, options) =>
  canSkipFitActivity(owner, activity, { ...options, garminAccountId: testGarminAccountId(owner) })

const requested = process.env.npm_lifecycle_event === 'test:db'
if (requested) config()
const enabled =
  requested &&
  (process.env.APP_DATABASE_ENV === 'test' || process.env.APP_DATABASE_ENV === 'development') &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.DIRECT_URL) &&
  !process.env.VERCEL_ENV
if (requested && !enabled)
  throw new Error('test:db requires isolated development/test database URLs')

describe.skipIf(!enabled)('activity import on isolated PostgreSQL', () => {
  let prisma: PrismaClient
  let ownerA: ReturnType<typeof getOwnerContext>
  let ownerB: ReturnType<typeof getOwnerContext>
  const prefix = `run24-${randomUUID()}`

  beforeAll(async () => {
    prisma = await getPrismaClient()
    const a = await prisma.user.create({ data: { authSubject: `${prefix}-a` } })
    const b = await prisma.user.create({ data: { authSubject: `${prefix}-b`, role: 'ADMIN' } })
    ownerA = getOwnerContext({ id: a.id, role: 'USER', email: null })
    ownerB = getOwnerContext({ id: b.id, role: 'ADMIN', email: null })
  }, 30_000)

  afterAll(async () => {
    if (!prisma) return
    await prisma.user.deleteMany({ where: { authSubject: { startsWith: prefix } } })
    await prisma.$disconnect()
  })

  const makeActivity = (
    userId: string,
    provider: 'GARMIN' | 'INTERVALS',
    externalActivityId: string,
  ) =>
    canonicalActivitySchema.parse({
      source: {
        userId,
        provider,
        externalActivityId,
        externalActivityUuid: null,
        recordType: 'API_ACTIVITY',
      },
      sportType: 'RUNNING',
      sourceSportType: 'running',
      startedAt: '2026-11-08T06:30:00.000Z',
      sourceTimezone: 'UTC',
      gpsAssetRef: null,
      distanceMeters: 5000,
      totalMs: 1800000,
      elapsedMs: 1800000,
      movingMs: null,
      avgSpeedMps: null,
      avgHrBpm: null,
      maxHrBpm: null,
      cadenceStepsPerMinute: null,
      elevationGainMeters: null,
      elevationLossMeters: null,
      laps: null,
    })

  it('rejects a fetched activity after its Garmin credential is replaced or removed', async () => {
    const priorVersion = process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION
    const priorKey = process.env.CREDENTIAL_ENCRYPTION_KEY_V1
    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1'
    process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = Buffer.alloc(32, 47).toString('base64')
    try {
      await saveProviderApiKey(ownerA, 'GARMIN', 'synthetic-original-garmin-key', {
        verifiedGarminAccountId: testGarminAccountId(ownerA),
      })
      const old = await readProviderApiKeySnapshot(ownerA, 'GARMIN')
      await saveProviderApiKey(ownerA, 'GARMIN', 'synthetic-replacement-garmin-key', {
        verifiedGarminAccountId: testGarminAccountId(ownerA),
      })
      const activity = makeActivity(ownerA.userId, 'GARMIN', 'credential-rotation')
      await expect(
        importCanonicalActivity(ownerA, activity, {
          beforeWrite: (tx) => assertProviderApiKeySnapshotCurrent(tx, ownerA, 'GARMIN', old.nonce),
        }),
      ).rejects.toBeInstanceOf(CredentialUnavailableError)
      expect(
        await prisma.activity.count({
          where: { userId: ownerA.userId, externalActivityId: 'credential-rotation' },
        }),
      ).toBe(0)
      const current = await readProviderApiKeySnapshot(ownerA, 'GARMIN')
      await importCanonicalActivity(ownerA, activity, {
        beforeWrite: (tx) =>
          assertProviderApiKeySnapshotCurrent(tx, ownerA, 'GARMIN', current.nonce),
      })
      await disconnectProvider(ownerA, 'GARMIN')
      await expect(
        importCanonicalActivity(
          ownerA,
          makeActivity(ownerA.userId, 'GARMIN', 'credential-removed'),
          {
            beforeWrite: (tx) =>
              assertProviderApiKeySnapshotCurrent(tx, ownerA, 'GARMIN', current.nonce),
          },
        ),
      ).rejects.toBeInstanceOf(CredentialUnavailableError)
    } finally {
      if (priorVersion === undefined) delete process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION
      else process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = priorVersion
      if (priorKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY_V1
      else process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = priorKey
    }
  })

  it('upserts modified activities and stable laps, rolling back a failed child write', async () => {
    const sparse = makeActivity(ownerA.userId, 'GARMIN', 'synthetic-1')
    const first = await importCanonicalActivity(ownerA, sparse)
    expect((await importCanonicalActivity(ownerA, sparse)).id).toBe(first.id)
    const withLaps = canonicalActivitySchema.parse({
      ...sparse,
      distanceMeters: 5000.125,
      laps: [
        {
          lapIndex: 0,
          startedAt: sparse.startedAt,
          distanceMeters: 5000.125,
          elapsedMs: 1800000,
          movingMs: null,
          avgHrBpm: null,
          avgSpeedMps: null,
          cadenceStepsPerMinute: null,
          sourceRecordType: 'FIT_LAP',
        },
      ],
    })
    await importCanonicalActivity(ownerA, withLaps)
    const lap = await prisma.activityLap.findFirstOrThrow({
      where: { userId: ownerA.userId, activityId: first.id },
    })
    await importCanonicalActivity(ownerA, withLaps)
    expect(
      (
        await prisma.activityLap.findFirstOrThrow({
          where: { userId: ownerA.userId, activityId: first.id },
        })
      ).id,
    ).toBe(lap.id)
    const invalidChild = canonicalActivitySchema.parse({
      ...withLaps,
      distanceMeters: 9000,
      laps: [{ ...withLaps.laps?.[0], lapIndex: 0, avgHrBpm: 3_000_000_000 }],
    })
    await expect(importCanonicalActivity(ownerA, invalidChild)).rejects.toThrow()
    expect((await getActivity(ownerA, first.id))?.distanceMeters).toBe(5000.125)
    expect((await getActivity(ownerA, first.id))?.laps).toHaveLength(1)
    expect(
      await prisma.activity.count({
        where: {
          userId: ownerA.userId,
          sourceProvider: 'GARMIN',
          externalActivityId: 'synthetic-1',
        },
      }),
    ).toBe(1)
  })

  it('retains verified laps for unchanged JSON and clears them after a changed summary', async () => {
    const base = makeActivity(ownerA.userId, 'GARMIN', 'synthetic-retained')
    const withLap = canonicalActivitySchema.parse({
      ...base,
      laps: [
        {
          lapIndex: 0,
          sourceRecordType: 'FIT_LAP',
          startedAt: base.startedAt,
          distanceMeters: 5000,
          elapsedMs: 1800000,
          movingMs: null,
          avgHrBpm: null,
          avgSpeedMps: null,
          cadenceStepsPerMinute: null,
        },
      ],
    })
    const saved = await importCanonicalActivity(ownerA, withLap)
    expect(await canSkipFitDownload(ownerA, base)).toBe(true)
    expect(
      await canSkipFitDownload(ownerB, {
        ...base,
        source: { ...base.source, userId: ownerB.userId },
      }),
    ).toBe(false)
    const before = await prisma.activityLap.findFirstOrThrow({
      where: { userId: ownerA.userId, activityId: saved.id },
    })
    const retained = await importCanonicalActivity(ownerA, base)
    expect(retained.lapImportStatus).toBe('RETAINED')
    expect(
      (
        await prisma.activityLap.findFirstOrThrow({
          where: { userId: ownerA.userId, activityId: saved.id },
        })
      ).id,
    ).toBe(before.id)
    const changed = await importCanonicalActivity(ownerA, { ...base, distanceMeters: 5100 })
    expect(await canSkipFitDownload(ownerA, { ...base, distanceMeters: 5100 })).toBe(false)
    expect(changed.lapImportStatus).toBe('UNAVAILABLE')
    expect(
      await prisma.activityLap.count({
        where: { userId: ownerA.userId, activityId: saved.id },
      }),
    ).toBe(0)
  })

  it('refreshes stale FIT laps even when the activity summary is unchanged', async () => {
    const base = makeActivity(ownerA.userId, 'GARMIN', 'synthetic-lap-correction')
    const firstLap = {
      lapIndex: 0,
      sourceRecordType: 'FIT_LAP',
      startedAt: base.startedAt,
      distanceMeters: 5000,
      elapsedMs: 1800000,
      movingMs: null,
      avgHrBpm: 140,
      avgSpeedMps: null,
      cadenceStepsPerMinute: null,
    }
    const checkedAt = new Date('2026-11-08T08:00:00Z')
    const correctedAt = new Date('2026-11-09T09:00:00Z')
    const saved = await importCanonicalActivity(
      ownerA,
      { ...base, laps: [firstLap] },
      {
        sourceObservedAt: checkedAt,
        fitCheckedAt: checkedAt,
      },
    )
    expect(
      await canSkipFitDownload(ownerA, base, {
        refresh: true,
        observedAt: new Date('2026-11-08T20:00:00Z'),
      }),
    ).toBe(true)
    expect(await canSkipFitDownload(ownerA, base, { refresh: true, observedAt: correctedAt })).toBe(
      false,
    )
    await importCanonicalActivity(
      ownerA,
      {
        ...base,
        laps: [{ ...firstLap, avgHrBpm: 150 }],
      },
      { sourceObservedAt: correctedAt, fitCheckedAt: correctedAt },
    )
    expect(
      await prisma.activityLap.findFirstOrThrow({
        where: { userId: ownerA.userId, activityId: saved.id },
      }),
    ).toMatchObject({ avgHrBpm: 150 })
    expect(await prisma.activity.findUniqueOrThrow({ where: { id: saved.id } })).toMatchObject({
      fitCheckedAt: correctedAt,
    })
  })

  it('does not recheck a missing FIT on each recent sync pass', async () => {
    const base = makeActivity(ownerA.userId, 'GARMIN', 'synthetic-missing-fit')
    const checkedAt = new Date('2026-11-08T08:00:00Z')
    const nextPass = new Date('2026-11-08T20:00:00Z')
    const afterRefresh = new Date('2026-11-09T09:00:00Z')
    const saved = await importCanonicalActivity(ownerA, base, {
      sourceObservedAt: checkedAt,
      fitCheckedAt: checkedAt,
    })
    expect(saved.lapImportStatus).toBe('UNAVAILABLE')
    expect(await canSkipFitDownload(ownerA, base, { observedAt: nextPass })).toBe(true)
    expect(await canSkipFitDownload(ownerA, base, { refresh: true, observedAt: nextPass })).toBe(
      true,
    )
    await importCanonicalActivity(ownerA, base, { sourceObservedAt: nextPass })
    expect(await prisma.activity.findUniqueOrThrow({ where: { id: saved.id } })).toMatchObject({
      fitCheckedAt: checkedAt,
      lapImportStatus: 'UNAVAILABLE',
    })
    expect(
      await canSkipFitDownload(ownerA, base, { refresh: true, observedAt: afterRefresh }),
    ).toBe(false)
    expect(
      await canSkipFitDownload(
        ownerA,
        { ...base, distanceMeters: 5100 },
        {
          refresh: true,
          observedAt: nextPass,
        },
      ),
    ).toBe(false)
    expect(
      await canSkipFitDownload(
        ownerB,
        {
          ...base,
          source: { ...base.source, userId: ownerB.userId },
        },
        { refresh: true, observedAt: nextPass },
      ),
    ).toBe(false)
  })

  it('retries FIT after changed JSON is saved without a successful FIT check', async () => {
    const base = makeActivity(ownerA.userId, 'GARMIN', 'synthetic-changed-fit-retry')
    const firstLap = {
      lapIndex: 0,
      sourceRecordType: 'FIT_LAP',
      startedAt: base.startedAt,
      distanceMeters: 5000,
      elapsedMs: 1800000,
      movingMs: null,
      avgHrBpm: 140,
      avgSpeedMps: null,
      cadenceStepsPerMinute: null,
    }
    const checkedAt = new Date('2026-11-08T08:00:00Z')
    const failedAt = new Date('2026-11-08T09:00:00Z')
    const retryAt = new Date('2026-11-08T10:00:00Z')
    const saved = await importCanonicalActivity(
      ownerA,
      { ...base, laps: [firstLap] },
      {
        sourceObservedAt: checkedAt,
        fitCheckedAt: checkedAt,
      },
    )
    const changed = { ...base, distanceMeters: 5100 }
    expect(await canSkipFitDownload(ownerA, changed, { refresh: true, observedAt: failedAt })).toBe(
      false,
    )
    const incomplete = await importCanonicalActivity(ownerA, changed, {
      sourceObservedAt: failedAt,
    })
    expect(incomplete).toMatchObject({ id: saved.id, lapImportStatus: 'UNAVAILABLE' })
    expect(await prisma.activity.findUniqueOrThrow({ where: { id: saved.id } })).toMatchObject({
      fitCheckedAt: null,
      lapImportStatus: 'UNAVAILABLE',
    })
    expect(await canSkipFitDownload(ownerA, changed, { refresh: true, observedAt: retryAt })).toBe(
      false,
    )
    await importCanonicalActivity(
      ownerA,
      { ...changed, laps: [{ ...firstLap, distanceMeters: 5100 }] },
      { sourceObservedAt: retryAt, fitCheckedAt: retryAt },
    )
    expect(await canSkipFitDownload(ownerA, changed, { refresh: true, observedAt: retryAt })).toBe(
      true,
    )
    expect(
      await prisma.activityLap.count({ where: { userId: ownerA.userId, activityId: saved.id } }),
    ).toBe(1)
  })

  it('keeps lap IDs with their source starts and rejects an older provider observation', async () => {
    const base = makeActivity(ownerA.userId, 'GARMIN', 'synthetic-reordered')
    const original = canonicalActivitySchema.parse({
      ...base,
      laps: [
        {
          lapIndex: 0,
          sourceRecordType: 'FIT_LAP',
          startedAt: base.startedAt,
          distanceMeters: 5000,
          elapsedMs: 1800000,
          movingMs: null,
          avgHrBpm: null,
          avgSpeedMps: null,
          cadenceStepsPerMinute: null,
        },
      ],
    })
    const saved = await importCanonicalActivity(ownerA, original, {
      sourceObservedAt: new Date('2026-11-08T10:00:00Z'),
    })
    const oldLap = await prisma.activityLap.findFirstOrThrow({
      where: { userId: ownerA.userId, activityId: saved.id },
    })
    const revised = canonicalActivitySchema.parse({
      ...original,
      startedAt: '2026-11-08T06:20:00.000Z',
      laps: [
        { ...original.laps?.[0], lapIndex: 0, startedAt: '2026-11-08T06:20:00.000Z' },
        { ...original.laps?.[0], lapIndex: 1 },
      ],
    })
    await importCanonicalActivity(ownerA, revised, {
      sourceObservedAt: new Date('2026-11-08T12:00:00Z'),
    })
    const shifted = await prisma.activityLap.findFirstOrThrow({
      where: { userId: ownerA.userId, activityId: saved.id, lapIndex: 1 },
    })
    expect(shifted.id).toBe(oldLap.id)
    const older = await importCanonicalActivity(ownerA, original, {
      sourceObservedAt: new Date('2026-11-08T11:00:00Z'),
    })
    expect(older.id).toBe(saved.id)
    expect((await getActivity(ownerA, saved.id))?.startedAt).toBe('2026-11-08T06:20:00.000Z')
    expect(
      (
        await prisma.activityLap.findFirstOrThrow({
          where: { userId: ownerA.userId, activityId: saved.id, lapIndex: 1 },
        })
      ).id,
    ).toBe(oldLap.id)
  })

  it('flags only same-owner cross-provider near matches and scopes paginated reads', async () => {
    const a = await importCanonicalActivity(
      ownerA,
      makeActivity(ownerA.userId, 'GARMIN', 'synthetic-2'),
    )
    const b = await importCanonicalActivity(
      ownerA,
      makeActivity(ownerA.userId, 'INTERVALS', 'synthetic-2'),
    )
    expect((await getActivity(ownerA, a.id))?.duplicateCandidateIds).toContain(b.id)
    expect((await getActivity(ownerA, b.id))?.duplicateCandidateIds).toContain(a.id)
    expect(await getActivity(ownerB, a.id)).toBeNull()
    expect((await listActivities(ownerB, 2)).items).toEqual([])
    const page = await listActivities(ownerA, 1)
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).not.toBeNull()
    expect((await listActivities(ownerA, 1, page.nextCursor ?? undefined)).items).toHaveLength(1)
    await expect(listActivities(ownerB, 1, page.nextCursor ?? undefined)).rejects.toThrow(
      'Invalid activity import',
    )
    await expect(
      importCanonicalActivity(ownerB, makeActivity(ownerA.userId, 'GARMIN', 'foreign')),
    ).rejects.toThrow('Invalid activity import')
    await prisma.integrationConnection.create({
      data: {
        userId: ownerB.userId,
        provider: 'GARMIN',
        authMethod: 'API_KEY',
        status: 'REVOKED',
        externalAccountId: testGarminAccountId(ownerB),
      },
    })
    const other = await importCanonicalActivity(
      ownerB,
      makeActivity(ownerB.userId, 'GARMIN', 'synthetic-2'),
    )
    expect(other.id).not.toBe(a.id)
    expect((await getActivity(ownerB, other.id))?.duplicateCandidateIds).toEqual([])
    await importCanonicalActivity(ownerA, {
      ...makeActivity(ownerA.userId, 'INTERVALS', 'synthetic-2'),
      distanceMeters: 9000,
    })
    expect((await getActivity(ownerA, a.id))?.duplicateCandidateIds).toEqual([])
    expect((await getActivity(ownerA, b.id))?.duplicateCandidateIds).toEqual([])
    await expect(
      prisma.activityLap.create({
        data: {
          userId: ownerB.userId,
          activityId: a.id,
          lapIndex: 0,
          sourceRecordType: 'FIT_LAP',
        },
      }),
    ).rejects.toThrow()
  })

  it('keeps the original page boundary when the cursor activity start time changes', async () => {
    const user = await prisma.user.create({ data: { authSubject: `${prefix}-pagination` } })
    const owner = getOwnerContext({ id: user.id, role: 'USER', email: null })
    await prisma.integrationConnection.create({
      data: {
        userId: owner.userId,
        provider: 'GARMIN',
        authMethod: 'API_KEY',
        status: 'REVOKED',
        externalAccountId: testGarminAccountId(owner),
      },
    })
    const base = makeActivity(owner.userId, 'GARMIN', 'pagination-a')
    const at = (externalActivityId: string, startedAt: string) =>
      canonicalActivitySchema.parse({
        ...base,
        source: { ...base.source, externalActivityId },
        startedAt,
      })
    const a = await importCanonicalActivity(owner, at('pagination-a', '2026-11-08T10:00:00Z'), {
      sourceObservedAt: new Date('2026-11-08T12:00:00Z'),
    })
    const b = await importCanonicalActivity(owner, at('pagination-b', '2026-11-08T09:00:00Z'))
    const c = await importCanonicalActivity(owner, at('pagination-c', '2026-11-08T08:00:00Z'))
    const first = await listActivities(owner, 1)
    expect(first.items.map((item) => item.id)).toEqual([a.id])
    expect(first.nextCursor).not.toBeNull()

    await importCanonicalActivity(owner, at('pagination-a', '2026-11-08T07:00:00Z'), {
      sourceObservedAt: new Date('2026-11-09T00:00:00Z'),
    })
    const second = await listActivities(owner, 1, first.nextCursor ?? undefined)
    expect(second.items.map((item) => item.id)).toEqual([b.id])
    const third = await listActivities(owner, 1, second.nextCursor ?? undefined)
    expect(third.items.map((item) => item.id)).toEqual([c.id])
    expect(third.nextCursor).toBeNull()
    expect((await getActivity(owner, a.id))?.startedAt).toBe('2026-11-08T07:00:00.000Z')
  })

  it('keeps one row and child set under concurrent reimports', async () => {
    const base = makeActivity(ownerA.userId, 'GARMIN', 'synthetic-concurrent')
    const activity = canonicalActivitySchema.parse({
      ...base,
      laps: [
        {
          lapIndex: 0,
          sourceRecordType: 'FIT_LAP',
          startedAt: base.startedAt,
          distanceMeters: 5000,
          elapsedMs: 1800000,
          movingMs: null,
          avgHrBpm: null,
          avgSpeedMps: null,
          cadenceStepsPerMinute: null,
        },
      ],
    })
    const results = await Promise.all(
      Array.from({ length: 2 }, () => importCanonicalActivity(ownerA, activity)),
    )
    expect(results[0].id).toBe(results[1].id)
    expect(
      await prisma.activity.count({
        where: { userId: ownerA.userId, externalActivityId: 'synthetic-concurrent' },
      }),
    ).toBe(1)
    expect(
      await prisma.activityLap.count({
        where: { userId: ownerA.userId, activityId: results[0].id },
      }),
    ).toBe(1)
  })

  it('keeps unverified legacy Garmin rows separate from verified account imports', async () => {
    const legacy = await prisma.activity.create({
      data: {
        userId: ownerA.userId,
        sourceProvider: 'GARMIN',
        externalActivityId: 'legacy-provenance-check',
        sportType: 'RUNNING',
        startedAt: new Date('2026-11-08T06:30:00Z'),
        listStartedAt: new Date('2026-11-08T06:30:00Z'),
      },
    })
    const verified = await importCanonicalActivity(
      ownerA,
      makeActivity(ownerA.userId, 'GARMIN', 'legacy-provenance-check'),
    )
    expect(verified.id).not.toBe(legacy.id)
    expect(
      await prisma.activity.count({
        where: { userId: ownerA.userId, externalActivityId: 'legacy-provenance-check' },
      }),
    ).toBe(2)
    expect(await getActivity(ownerA, legacy.id)).toBeNull()
    expect((await getActivity(ownerA, verified.id))?.id).toBe(verified.id)
  })
})
