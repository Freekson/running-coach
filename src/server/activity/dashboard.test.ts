import { beforeEach, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
const mocks = vi.hoisted(() => ({ connection: vi.fn(), rows: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
vi.mock('@/server/db/client', () => ({
  getPrismaClient: async () => ({
    integrationConnection: { findUnique: mocks.connection },
    activity: { findMany: mocks.rows },
  }),
}))
import { getOwnerContext } from '@/server/authorization/ownership'
import { getDashboardActivityOverview, getDashboardRecentActivities } from './history'
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
const now = new Date('2026-11-13T06:00:00Z')
beforeEach(() => {
  vi.clearAllMocks()
  mocks.rows.mockResolvedValue([])
  mocks.connection.mockImplementation(async ({ where }) =>
    where.userId_provider.userId === owner.userId ? { externalAccountId: 'account-a' } : null,
  )
})

it('uses the shared owner/account visibility and excludes unresolved duplicate candidates from summaries', async () => {
  const result = await getDashboardActivityOverview(owner, 'Asia/Tokyo', now)
  expect(result.weeks).toHaveLength(8)
  expect(mocks.rows).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        AND: [
          {
            AND: [
              {
                userId: owner.userId,
                OR: [
                  { sourceProvider: { not: 'GARMIN' } },
                  { sourceProvider: 'GARMIN', garminAccountId: 'account-a' },
                ],
              },
              {
                duplicateCandidatesAsFirst: { none: { userId: owner.userId } },
                duplicateCandidatesAsSecond: { none: { userId: owner.userId } },
              },
            ],
          },
          { sportType: 'RUNNING', startedAt: { gte: new Date('2026-09-20T15:00:00Z'), lte: now } },
        ],
      },
    }),
  )
  expect(mocks.rows.mock.calls[0][0].select).not.toHaveProperty('rawObjectRef')
  expect(mocks.rows.mock.calls[0][0].select).not.toHaveProperty('laps')
})

it('limits recent activities to three, with deterministic ordering and the different admin’s own scope', async () => {
  await getDashboardRecentActivities(other, now)
  expect(mocks.rows).toHaveBeenCalledWith(
    expect.objectContaining({
      take: 3,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      where: {
        AND: [
          {
            AND: [
              { userId: other.userId, OR: [{ sourceProvider: { not: 'GARMIN' } }] },
              {
                duplicateCandidatesAsFirst: { none: { userId: other.userId } },
                duplicateCandidatesAsSecond: { none: { userId: other.userId } },
              },
            ],
          },
          { startedAt: { lte: now } },
        ],
      },
    }),
  )
})

it('serializes the existing canonical read model without confusing missing HR with zero', async () => {
  mocks.rows.mockResolvedValue([
    {
      id: 'a',
      activityTitle: 'Synthetic run',
      sportType: 'RUNNING',
      sourceSportType: null,
      sourceProvider: 'GARMIN',
      startedAt: new Date('2026-11-12T00:00:00Z'),
      distanceMeters: new Prisma.Decimal(5000),
      totalMs: BigInt(1_800_000),
      movingMs: null,
      elapsedMs: null,
      avgSpeedMps: null,
      avgHrBpm: null,
    },
  ])
  expect((await getDashboardActivityOverview(owner, 'UTC', now)).weeks[7]).toMatchObject({
    distanceMeters: 5000,
    durationMs: 1_800_000,
    avgHrBpm: null,
  })
  expect((await getDashboardRecentActivities(owner, now))[0]).toMatchObject({
    id: 'a',
    distanceMeters: 5000,
    timerMs: 1_800_000,
    avgHrBpm: null,
  })
})

it('rejects an invalid timezone before reading activities', async () => {
  await expect(getDashboardActivityOverview(owner, 'invalid', now)).rejects.toThrow()
  expect(mocks.rows).not.toHaveBeenCalled()
})
