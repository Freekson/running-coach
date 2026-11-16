import { expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
import { getOwnerContext } from '@/server/authorization/ownership'
import { addHealthDays } from '@/lib/health-history'
import { activityCoverage, readStoredRecovery } from './stored-context'
import { fixtureId, fixtureNow, runFixture } from './fixtures'
import { buildTrainingEvidence } from './evidence'

const full = {
  cursorOrCheckpoint: {
    version: 2,
    timezone: 'Asia/Tokyo',
    startDate: '2026-08-23',
    endDate: '2026-11-14',
    nextDate: null,
  },
  lastSyncedAt: fixtureNow,
  consecutiveFailures: 0,
}
it('uses verified cursor windows rather than activity presence, and compresses coverage', () => {
  expect(activityCoverage([full], 'Asia/Tokyo', fixtureNow)).toMatchObject({
    status: 'sufficient',
    completeWindows: [{ startDate: '2026-08-23', endDate: '2026-11-14' }],
    failedWindows: [],
    unfetchedWindows: [],
  })
  expect(activityCoverage([], 'Asia/Tokyo', fixtureNow)).toMatchObject({
    status: 'unknown',
    completeWindows: [],
    unfetchedWindows: [{ startDate: '2026-08-23', endDate: '2026-11-14' }],
  })
})
it('uses persisted cumulative coverage after the recent window moves without inventing legacy gaps', () => {
  const historical = {
    ...full,
    dataType: 'GARMIN_IMPORT_ACTIVITIES',
    lastSyncedAt: new Date('2026-10-02T02:00:00Z'),
    cursorOrCheckpoint: { ...full.cursorOrCheckpoint, endDate: '2026-10-01' },
  }
  const recent = {
    ...full,
    dataType: 'GARMIN_IMPORT_ACTIVITIES_RECENT',
    cursorOrCheckpoint: {
      ...full.cursorOrCheckpoint,
      startDate: '2026-11-08',
      endDate: '2026-11-15',
      confirmedWindows: [{ startDate: '2026-08-23', endDate: '2026-11-14' }],
    },
  }
  const coverage = activityCoverage([historical, recent], 'Asia/Tokyo', fixtureNow)
  expect(coverage.status).toBe('sufficient')
  expect(coverage.unfetchedWindows).toEqual([])
  const owner = getOwnerContext({ id: fixtureId(900), role: 'USER', email: null })
  const evidence = buildTrainingEvidence(owner, [runFixture(owner.userId)], {
    coverage,
    timezone: 'Asia/Tokyo',
    now: fixtureNow,
    includeHeartRate: false,
    includeLaps: false,
  })
  expect(evidence.recentTrainingSummary.rollingTotals.map((total) => total.distance.value)).toEqual(
    [5000, 5000, 5000],
  )
  const legacy = {
    ...recent,
    cursorOrCheckpoint: { ...recent.cursorOrCheckpoint, confirmedWindows: undefined },
  }
  expect(activityCoverage([historical, legacy], 'Asia/Tokyo', fixtureNow).unfetchedWindows).toEqual(
    [{ startDate: '2026-10-02', endDate: '2026-11-07' }],
  )
  expect(
    activityCoverage([historical, recent], 'America/New_York', fixtureNow).completeWindows,
  ).toEqual([])
})
it('keeps failed dates and unfinished import explicit even before the first successful sync', () => {
  const coverage = activityCoverage(
    [
      {
        ...full,
        lastSyncedAt: null,
        consecutiveFailures: 1,
        cursorOrCheckpoint: { ...full.cursorOrCheckpoint, nextDate: '2026-11-14' },
      },
    ],
    'Asia/Tokyo',
    fixtureNow,
  )
  expect(coverage.status).toBe('partial')
  expect(coverage.lastManualSyncAt).toBeNull()
  expect(coverage.completeWindows).toEqual([])
  expect(coverage.failedWindows).toEqual([{ startDate: '2026-08-23', endDate: '2026-11-14' }])
})
it('rejects malformed, mismatched-zone and future sync evidence and never covers today', () => {
  expect(
    activityCoverage([{ ...full, cursorOrCheckpoint: {} }], 'Asia/Tokyo', fixtureNow).status,
  ).toBe('unknown')
  expect(activityCoverage([full], 'America/New_York', fixtureNow).completeWindows).toEqual([])
  expect(
    activityCoverage([{ ...full, lastSyncedAt: new Date('2027-01-01') }], 'Asia/Tokyo', fixtureNow)
      .completeWindows,
  ).toEqual([])
  const currentDay = activityCoverage(
    [{ ...full, cursorOrCheckpoint: { ...full.cursorOrCheckpoint, endDate: '2026-11-15' } }],
    'Asia/Tokyo',
    fixtureNow,
  )
  expect(currentDay.window?.endDate).toBe('2026-11-14')
})
it('exports dated recovery only from the current owner/account and gates HRV on seven valid days', async () => {
  const owner = getOwnerContext({ id: fixtureId(900), role: 'USER', email: null })
  const rows = Array.from({ length: 7 }, (_, i) => ({
    localDate: new Date(addHealthDays('2026-11-14', -i)),
    sourceTimezone: 'Asia/Tokyo',
    sleepSourceTimezone: 'Asia/Tokyo',
    restingHrBpm: 55,
    hrvMs: new Prisma.Decimal(42),
    sleepDurationMs: BigInt(28800000),
    summaryFetchedAt: fixtureNow,
    sleepFetchedAt: fixtureNow,
  }))
  const tx = {
    integrationConnection: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: fixtureId(10), externalAccountId: 'PRIVATE-ACCOUNT' }),
    },
    syncCursor: {
      findMany: vi.fn().mockResolvedValue([
        {
          cursorOrCheckpoint: {
            version: 1,
            timezone: 'Asia/Tokyo',
            startDate: '2026-10-18',
            endDate: '2026-11-14',
            nextDate: null,
            failedDates: ['2026-11-01'],
          },
        },
      ]),
    },
    dailyHealthMetric: { findMany: vi.fn().mockResolvedValue(rows) },
  }
  const recovery = await readStoredRecovery(tx, owner, 'Asia/Tokyo', fixtureNow)
  expect(recovery?.days[0]).toMatchObject({
    date: '2026-11-14',
    restingHr: { value: 55 },
    hrv: { value: 42 },
    sleepDuration: { value: 28800 },
  })
  expect(recovery?.coverage.failedWindows).toEqual([
    { startDate: '2026-11-01', endDate: '2026-11-01' },
  ])
  expect(tx.dailyHealthMetric.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ userId: owner.userId, garminAccountId: 'PRIVATE-ACCOUNT' }),
    }),
  )
  expect(JSON.stringify(recovery)).not.toContain('PRIVATE-ACCOUNT')
  rows[0].summaryFetchedAt = new Date('2027-01-01')
  const sparse = await readStoredRecovery(tx, owner, 'Asia/Tokyo', fixtureNow)
  expect(sparse?.days.every((day) => day.hrv.value === null)).toBe(true)
  tx.integrationConnection.findUnique.mockResolvedValue(null)
  expect((await readStoredRecovery(tx, owner, 'Asia/Tokyo', fixtureNow))?.days).toEqual([])
})
