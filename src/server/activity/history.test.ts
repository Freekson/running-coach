import { beforeEach, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'

const db = vi.hoisted(() => ({
  integrationConnection: { findUnique: vi.fn() },
  athleteProfile: { findUnique: vi.fn() },
  activity: { count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() },
  syncCursor: { findFirst: vi.fn() },
  $transaction: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
vi.mock('@/server/db/client', () => ({ getPrismaClient: async () => db }))
import { getOwnerContext } from '@/server/authorization/ownership'
import { activityDayBoundary, getActivityHistory } from './history'

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
  db.$transaction.mockImplementation((callback: (tx: typeof db) => unknown) => callback(db))
  db.integrationConnection.findUnique.mockResolvedValue({ externalAccountId: 'account-a' })
  db.athleteProfile.findUnique.mockResolvedValue({ preferredTimezone: 'Asia/Tokyo' })
  db.activity.count.mockResolvedValue(30)
  db.activity.groupBy.mockImplementation(async ({ by }: { by: string[] }) =>
    by[0] === 'sportType'
      ? [{ sportType: 'RUNNING' }, { sportType: 'WALKING' }]
      : [{ sourceProvider: 'GARMIN' }],
  )
  db.activity.findMany.mockResolvedValue([])
  db.activity.aggregate.mockResolvedValue({ _min: { startedAt: null }, _max: { importedAt: null } })
  db.syncCursor.findFirst.mockResolvedValue(null)
})

it('composes filters under the owner/account scope and fetches only the selected page', async () => {
  await getActivityHistory(owner, {
    q: '100% run',
    sport: 'RUNNING',
    provider: 'GARMIN',
    range: 'custom',
    from: '2026-11-11',
    to: '2026-11-12',
    minDistance: 5,
    page: 2,
    pageSize: 10,
    sort: 'oldest',
  })
  expect(db.activity.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      take: 10,
      skip: 10,
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      where: {
        AND: [
          expect.objectContaining({
            userId: owner.userId,
            OR: [
              { sourceProvider: { not: 'GARMIN' } },
              { sourceProvider: 'GARMIN', garminAccountId: 'account-a' },
            ],
          }),
          {
            activityTitle: { contains: '100\\% run', mode: 'insensitive' },
            sportType: 'RUNNING',
            sourceProvider: 'GARMIN',
            distanceMeters: { gte: 5000 },
            startedAt: {
              gte: new Date('2026-11-10T15:00:00Z'),
              lt: new Date('2026-11-12T15:00:00Z'),
            },
          },
        ],
      },
    }),
  )
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: 'RepeatableRead',
  })
})
it('keeps an admin owner-scoped and clamps pages without unbounded reads', async () => {
  db.activity.count.mockResolvedValue(12)
  const page = await getActivityHistory(other, { page: 999999, sort: 'distance' })
  expect(page).toMatchObject({ page: 2, pageCount: 2, total: 12 })
  expect(db.activity.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      take: 10,
      skip: 10,
      where: { AND: [expect.objectContaining({ userId: other.userId }), {}] },
      orderBy: [
        { distanceMeters: { sort: 'desc', nulls: 'last' } },
        { startedAt: 'desc' },
        { id: 'desc' },
      ],
    }),
  )
})
it('serializes future sport types and null metrics without loading raw records', async () => {
  db.activity.findMany.mockResolvedValue([
    {
      id: 'row',
      activityTitle: null,
      sportType: 'OTHER',
      sourceSportType: 'rowing',
      sourceProvider: 'FILE',
      startedAt: new Date('2026-11-12T00:00:00Z'),
      distanceMeters: new Prisma.Decimal(2500),
      totalMs: BigInt(900000),
      movingMs: null,
      elapsedMs: null,
      avgSpeedMps: null,
      avgHrBpm: null,
    },
  ])
  const page = await getActivityHistory(owner, {})
  expect(page.items[0]).toMatchObject({
    sport: 'OTHER',
    sourceSport: 'rowing',
    distanceMeters: 2500,
    timerMs: 900000,
    avgHrBpm: null,
    avgSpeedMps: null,
  })
  expect(db.activity.findMany.mock.calls[0][0].select).not.toHaveProperty('rawObjectRef')
  expect(db.activity.findMany.mock.calls[0][0].select).not.toHaveProperty('laps')
})
it('rejects invalid filters before reading the activity table', async () => {
  await expect(getActivityHistory(owner, { pageSize: 50000 })).rejects.toThrow()
  expect(db.activity.findMany).not.toHaveBeenCalled()
})
it('uses timezone calendar boundaries across DST and skipped midnights', () => {
  expect(activityDayBoundary('2026-11-01', 'America/New_York').toISOString()).toBe(
    '2026-11-01T04:00:00.000Z',
  )
  expect(activityDayBoundary('2026-11-02', 'America/New_York').toISOString()).toBe(
    '2026-11-02T05:00:00.000Z',
  )
  expect(activityDayBoundary('2026-03-08', 'America/New_York').toISOString()).toBe(
    '2026-03-08T05:00:00.000Z',
  )
  expect(activityDayBoundary('2026-03-09', 'America/New_York').toISOString()).toBe(
    '2026-03-09T04:00:00.000Z',
  )
  expect(activityDayBoundary('2018-11-04', 'America/Sao_Paulo').toISOString()).toBe(
    '2018-11-04T03:00:00.000Z',
  )
})

it.each([
  ['1', { gte: 1000 }],
  ['3', { gte: 3000 }],
  ['5', { gte: 5000 }],
  ['10', { gte: 10000 }],
  ['21.0975', { gte: 21097.5 }],
  ['42.195', { gte: 42195 }],
  ['ultra', { gt: 42195 }],
])('filters the %s distance preset at its correct boundary', async (minDistance, expected) => {
  await getActivityHistory(owner, { sport: 'RUNNING', minDistance })
  expect(db.activity.findMany.mock.calls[0][0].where.AND[1].distanceMeters).toEqual(expected)
})

it('uses the browser timezone for filtering ahead of a different profile timezone', async () => {
  await getActivityHistory(
    owner,
    { range: 'custom', from: '2026-11-12', to: '2026-11-12' },
    { timezone: 'America/Los_Angeles' },
  )
  expect(db.activity.findMany.mock.calls[0][0].where.AND[1].startedAt).toEqual({
    gte: new Date('2026-11-12T08:00:00Z'),
    lt: new Date('2026-11-13T08:00:00Z'),
  })
})

it('bounds date pickers by the first visible activity in local time, independently of filters', async () => {
  db.activity.aggregate.mockResolvedValue({
    _min: { startedAt: new Date('2018-12-31T16:00:00Z') },
    _max: { importedAt: null },
  })
  const page = await getActivityHistory(
    other,
    { q: 'No matches', range: '7' },
    { now: new Date('2026-11-11T16:00:00Z'), timezone: 'Asia/Tokyo' },
  )
  expect(page.dateBounds).toEqual({ min: '2019-01-01', max: '2026-11-12' })
  expect(db.activity.aggregate).toHaveBeenCalledWith({
    where: {
      userId: other.userId,
      OR: [
        { sourceProvider: { not: 'GARMIN' } },
        { sourceProvider: 'GARMIN', garminAccountId: 'account-a' },
      ],
    },
    _min: { startedAt: true },
    _max: { importedAt: true },
  })
})

it('uses 2020 as the calendar fallback for empty history and never exposes future years', async () => {
  const options = { now: new Date('2026-11-11T16:00:00Z'), timezone: 'America/Los_Angeles' }
  expect((await getActivityHistory(owner, {}, options)).dateBounds).toEqual({
    min: '2020-01-01',
    max: '2026-11-11',
  })
  db.activity.aggregate.mockResolvedValue({
    _min: { startedAt: new Date('2027-01-01T00:00:00Z') },
    _max: { importedAt: null },
  })
  expect((await getActivityHistory(owner, {}, options)).dateBounds).toEqual({
    min: '2026-11-11',
    max: '2026-11-11',
  })
})
