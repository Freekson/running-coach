import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import type { GoalRecord } from '@/lib/goals'

const db = vi.hoisted(() => ({
  goals: vi.fn(),
  rows: vi.fn(),
  profile: vi.fn(),
  connection: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
vi.mock('@/server/db/client', () => ({
  getPrismaClient: async () => ({
    goal: { findMany: db.goals },
    activity: { findMany: db.rows },
    athleteProfile: { findUnique: db.profile },
    integrationConnection: { findUnique: db.connection },
  }),
}))
import { getOwnerContext, InvalidOwnerContextError } from '@/server/authorization/ownership'
import { calculateGoalProgress, withGoalProgress, type GoalActivity } from './progress'
import { listGoalsWithProgress } from './goals'

const now = new Date('2026-11-14T06:00:00Z')
const goal: GoalRecord = {
  id: 'synthetic',
  name: 'An arbitrary distance',
  archived: false,
  type: 'PERFORMANCE',
  distanceMeters: 83501.125,
  targetTimeSeconds: 36000,
  targetCount: null,
  measurementWindow: null,
  targetDate: null,
  surface: 'ANY',
  elevationGainM: null,
}
const run: GoalActivity = {
  startedAt: new Date('2026-11-12T05:00:00Z'),
  sportType: 'RUNNING',
  surfaceType: 'TRAIL',
  distanceMeters: 83501.125,
  elapsedSeconds: 36500,
  elevationGainM: 2400,
}
const calculate = (
  patch: Partial<GoalRecord> = {},
  runs: GoalActivity[] = [run],
  zone = 'UTC',
  at = now,
) => calculateGoalProgress({ ...goal, ...patch }, runs, zone, at)

describe('goal progress calculations', () => {
  it('never establishes a target-distance result from a shorter run', () => {
    for (const distanceMeters of [2970, 2999.999])
      expect(
        calculate({ distanceMeters: 3000, targetTimeSeconds: 600 }, [
          { ...run, distanceMeters, elapsedSeconds: 599 },
        ]),
      ).toMatchObject({ achieved: false, status: 'ACTIVE', bestTimeSeconds: null })
    expect(
      calculate({ distanceMeters: 3000, targetTimeSeconds: 600 }, [
        { ...run, distanceMeters: 3000, elapsedSeconds: 599 },
      ]).achieved,
    ).toBe(true)
  })

  it.each([29, 57, 58, 99])(
    'keeps exactly %s percent without floating-point undercount',
    (percent) => {
      expect(
        calculate(
          {
            type: 'VOLUME',
            measurementWindow: 'MONTH',
            distanceMeters: 100000,
            targetTimeSeconds: null,
          },
          [{ ...run, distanceMeters: percent * 1000 }],
        ).percent,
      ).toBe(percent)
      expect(
        calculate(
          {
            type: 'CONSISTENCY',
            measurementWindow: 'MONTH',
            distanceMeters: null,
            targetCount: 100,
            targetTimeSeconds: null,
          },
          Array.from({ length: percent }, () => run),
        ).percent,
      ).toBe(percent)
    },
  )

  it('uses best whole-run elapsed time without extrapolating longer runs or inventing a target', () => {
    expect(
      calculate({}, [
        run,
        { ...run, elapsedSeconds: 35999 },
        { ...run, distanceMeters: 161000, elapsedSeconds: 100 },
      ]),
    ).toMatchObject({
      bestTimeSeconds: 35999,
      achieved: true,
      status: 'ACHIEVED',
      percent: null,
    })
    expect(calculate().status).toBe('ACTIVE')
    expect(calculate({ targetTimeSeconds: null }).achieved).toBe(false)
    expect(calculate({}, [{ ...run, elapsedSeconds: null }]).bestTimeSeconds).toBeNull()
    expect(calculate({}, [])).toMatchObject({
      bestTimeSeconds: null,
      achieved: false,
      planCoverage: 'UNAVAILABLE',
    })
  })
  it('requires distance, selected surface and elevation on one completion run', () => {
    const patch: Partial<GoalRecord> = {
      type: 'COMPLETION',
      targetTimeSeconds: null,
      surface: 'TRAIL',
      elevationGainM: 2400,
    }
    expect(calculate(patch).achieved).toBe(true)
    for (const change of [
      { surfaceType: null },
      { surfaceType: 'ROAD' },
      { elevationGainM: null },
      { elevationGainM: 2399 },
      { distanceMeters: 83501 },
      { distanceMeters: null },
    ])
      expect(calculate(patch, [{ ...run, ...change }]).achieved).toBe(false)
  })
  it('uses Monday boundaries in the athlete timezone, ignoring other sports and future runs', () => {
    expect(
      calculate(
        {
          type: 'CONSISTENCY',
          targetTimeSeconds: null,
          distanceMeters: null,
          targetCount: 4,
          measurementWindow: 'WEEK',
        },
        [
          run,
          { ...run, startedAt: new Date('2026-11-08T15:00:00Z') },
          { ...run, startedAt: new Date('2026-11-08T14:59:59Z') },
          { ...run, sportType: 'CYCLING' },
          { ...run, startedAt: new Date('2026-11-14T06:00:01Z') },
        ],
        'Asia/Tokyo',
      ),
    ).toMatchObject({ from: '2026-11-09', runCount: 2, percent: 50 })
  })
  it.each([
    ['MONTH', '2026-11-01', '2026-10-31T23:59:59Z'],
    ['YEAR', '2026-01-01', '2025-12-31T23:59:59Z'],
  ] as const)('sums only the calendar %s and caps its bar', (measurementWindow, from, outside) => {
    expect(
      calculate(
        { type: 'VOLUME', measurementWindow, targetTimeSeconds: null, distanceMeters: 100000 },
        [run, run, { ...run, startedAt: new Date(outside) }],
      ),
    ).toMatchObject({
      from,
      distanceMeters: 167002.25,
      achieved: true,
      percent: 100,
    })
  })
  it('handles fractional distances and cumulative elevation using the lower completion ratio', () => {
    expect(
      calculate(
        {
          type: 'VOLUME',
          measurementWindow: 'MONTH',
          targetTimeSeconds: null,
          distanceMeters: 0.3,
          elevationGainM: 100,
        },
        [
          { ...run, distanceMeters: 0.1, elevationGainM: 20 },
          { ...run, distanceMeters: 0.2, elevationGainM: 30 },
        ],
      ),
    ).toMatchObject({ distanceMeters: 0.3, percent: 50, achieved: false })
  })
  it('includes the full deadline day, freezes its period and distinguishes today from overdue', () => {
    expect(
      calculate(
        {
          type: 'VOLUME',
          measurementWindow: 'MONTH',
          targetTimeSeconds: null,
          distanceMeters: 100000,
          targetDate: '2026-10-31',
        },
        [
          run,
          { ...run, startedAt: new Date('2026-10-31T14:59:59Z') },
          { ...run, startedAt: new Date('2026-10-31T15:00:00Z') },
        ],
        'Asia/Tokyo',
      ),
    ).toMatchObject({
      from: '2026-10-01',
      through: '2026-10-31',
      runCount: 1,
      status: 'OVERDUE',
      daysRemaining: -14,
    })
    expect(calculate({ targetDate: '2026-11-14' })).toMatchObject({
      status: 'ACTIVE',
      daysRemaining: 0,
    })
    expect(calculate({ targetDate: '2026-11-15' }).daysRemaining).toBe(1)
    expect(calculate({ targetDate: '2026-11-13' }).status).toBe('OVERDUE')
  })
  it('prefers achieved over overdue and archived over achieved', () => {
    const patch = { targetDate: '2026-11-13', targetTimeSeconds: 37000 }
    expect(calculate(patch).status).toBe('ACHIEVED')
    expect(calculate({ ...patch, archived: true })).toMatchObject({
      status: 'ARCHIVED',
      achieved: true,
    })
  })
  it('counts calendar days through DST and resets a recurring goal at its next period', () => {
    expect(
      calculate(
        { targetDate: '2026-11-02' },
        [],
        'America/New_York',
        new Date('2026-10-31T12:00:00Z'),
      ).daysRemaining,
    ).toBe(2)
    const patch: Partial<GoalRecord> = {
      type: 'CONSISTENCY',
      distanceMeters: null,
      targetTimeSeconds: null,
      targetCount: 1,
      measurementWindow: 'WEEK',
    }
    expect(calculate(patch).achieved).toBe(true)
    expect(calculate(patch, [run], 'UTC', new Date('2026-11-16T12:00:00Z'))).toMatchObject({
      from: '2026-11-16',
      runCount: 0,
      achieved: false,
    })
  })
})

describe('owner-scoped progress reads', () => {
  const owner = getOwnerContext({
    id: '00000000-0000-4000-8000-000000000001',
    role: 'USER',
    email: null,
  })
  const other = getOwnerContext({
    id: '00000000-0000-4000-8000-000000000002',
    role: 'ADMIN',
    email: null,
  })
  beforeEach(() => {
    vi.clearAllMocks()
    db.goals.mockResolvedValue([
      { ...goal, distanceMeters: new Prisma.Decimal(goal.distanceMeters!), targetDate: null },
    ])
    db.profile.mockResolvedValue({ preferredTimezone: 'Asia/Tokyo' })
    db.connection.mockResolvedValue({ externalAccountId: 'account-a' })
    db.rows.mockResolvedValue([
      {
        ...run,
        distanceMeters: new Prisma.Decimal(run.distanceMeters!),
        elapsedMs: BigInt(36500000),
        elevationGainMeters: new Prisma.Decimal(2400),
      },
    ])
  })
  it('bounds periodic goal queries to their earliest local start and final deadline', async () => {
    await withGoalProgress(
      owner,
      [
        {
          ...goal,
          type: 'VOLUME',
          targetTimeSeconds: null,
          measurementWindow: 'MONTH',
          targetDate: '2026-10-31',
        },
      ],
      now,
    )
    expect(db.rows.mock.calls[0][0].where.AND[1].startedAt).toEqual({
      gte: new Date('2026-09-30T15:00:00Z'),
      lt: new Date('2026-10-31T15:00:00Z'),
      lte: now,
    })
  })

  it('reuses date formatters across large histories and multiple goals', async () => {
    db.rows.mockResolvedValue(
      Array.from({ length: 2000 }, () => ({
        ...run,
        distanceMeters: new Prisma.Decimal(5000),
        elapsedMs: BigInt(1000000),
        elevationGainMeters: null,
      })),
    )
    const formatter = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts')
    try {
      const result = await withGoalProgress(
        owner,
        Array.from({ length: 10 }, () => goal),
        now,
      )
      expect(result).toHaveLength(10)
      expect(formatter).toHaveBeenCalledTimes(2001)
    } finally {
      formatter.mockRestore()
    }
  })

  it('recognizes recorded Garmin surfaces on legacy rows and exposes unknown-surface exclusions', async () => {
    const surfaceGoal = { ...goal, surface: 'TRAIL' as const }
    db.rows.mockResolvedValue([
      {
        ...run,
        surfaceType: null,
        sourceProvider: 'GARMIN',
        sourceSportType: 'trail_running',
        distanceMeters: new Prisma.Decimal(run.distanceMeters!),
        elapsedMs: BigInt(36500000),
        elevationGainMeters: null,
      },
      {
        ...run,
        surfaceType: null,
        sourceProvider: 'GARMIN',
        sourceSportType: 'running',
        distanceMeters: new Prisma.Decimal(5000),
        elapsedMs: null,
        elevationGainMeters: null,
      },
    ])
    expect((await withGoalProgress(owner, [surfaceGoal], now))[0].progress).toMatchObject({
      runCount: 1,
      bestTimeSeconds: 36500,
      surfaceUnknownRunCount: 1,
    })
  })
  it.each([owner, other])(
    'scopes every read to the verified owner, including another ADMIN',
    async (context) => {
      const result = await listGoalsWithProgress(context, now)
      expect(db.goals.mock.calls[0][0].where).toEqual({ userId: context.userId })
      expect(db.profile.mock.calls[0][0].where).toEqual({ userId: context.userId })
      expect(db.connection.mock.calls[0][0].where.userId_provider.userId).toBe(context.userId)
      expect(db.rows.mock.calls[0][0]).toEqual({
        where: {
          AND: [
            {
              userId: context.userId,
              OR: [
                { sourceProvider: { not: 'GARMIN' } },
                { sourceProvider: 'GARMIN', garminAccountId: 'account-a' },
              ],
            },
            {
              sportType: 'RUNNING',
              startedAt: { lte: now },
              duplicateCandidatesAsFirst: { none: { userId: context.userId } },
              duplicateCandidatesAsSecond: { none: { userId: context.userId } },
            },
          ],
        },
        select: {
          startedAt: true,
          sportType: true,
          surfaceType: true,
          sourceProvider: true,
          sourceSportType: true,
          distanceMeters: true,
          elapsedMs: true,
          elevationGainMeters: true,
        },
      })
      expect(result[0].progress).toMatchObject({ bestTimeSeconds: 36500, timezone: 'Asia/Tokyo' })
      expect(JSON.stringify(result)).not.toContain('account-a')
    },
  )
  it('rejects forged or unauthenticated owners before querying', async () => {
    await expect(listGoalsWithProgress({ userId: other.userId })).rejects.toBeInstanceOf(
      InvalidOwnerContextError,
    )
    expect(db.goals).not.toHaveBeenCalled()
    expect(db.rows).not.toHaveBeenCalled()
  })
  it('falls back to UTC for invalid timezone and skips activity reads without goals', async () => {
    db.profile.mockResolvedValue({ preferredTimezone: 'invalid' })
    expect((await listGoalsWithProgress(owner, now))[0].progress.timezone).toBe('UTC')
    db.rows.mockClear()
    db.goals.mockResolvedValue([])
    expect(await listGoalsWithProgress(owner, now)).toEqual([])
    expect(db.rows).not.toHaveBeenCalled()
  })
})
