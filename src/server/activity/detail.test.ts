import { beforeEach, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
const db = vi.hoisted(() => ({
  activity: { findFirst: vi.fn() },
  integrationConnection: { findUnique: vi.fn() },
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
vi.mock('@/server/db/client', () => ({ getPrismaClient: async () => db }))
import { getOwnerContext } from '@/server/authorization/ownership'
import { getActivityDetail } from './detail'
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
const id = '00000000-0000-4000-8000-000000000079'
beforeEach(() => {
  vi.clearAllMocks()
  db.integrationConnection.findUnique.mockResolvedValue({
    externalAccountId: '79',
    status: 'DISCONNECTED',
    credential: null,
  })
})
it('returns saved summary and laps while disconnected, using owner-scoped projections only', async () => {
  db.activity.findFirst.mockResolvedValue({
    id,
    activityTitle: 'Saved run',
    sportType: 'RUNNING',
    sourceSportType: 'running',
    sourceProvider: 'GARMIN',
    externalActivityId: '123',
    externalActivityUuid: null,
    sourceTimezone: null,
    startedAt: new Date('2026-11-08T08:00:00Z'),
    distanceMeters: new Prisma.Decimal(4000),
    totalMs: BigInt(1200_000),
    movingMs: null,
    elapsedMs: null,
    avgSpeedMps: null,
    avgHrBpm: null,
    maxHrBpm: null,
    cadence: null,
    elevationGainMeters: null,
    elevationLossMeters: null,
    calories: null,
    lapImportStatus: 'IMPORTED',
    laps: [
      {
        lapIndex: 0,
        startedAt: null,
        distanceMeters: new Prisma.Decimal(1000),
        timerMs: BigInt(300_000),
        movingMs: null,
        elapsedMs: BigInt(305_000),
        avgSpeedMps: null,
        avgHrBpm: null,
        maxHrBpm: null,
        avgPowerWatts: new Prisma.Decimal(200),
        maxPowerWatts: null,
        cadenceCyclesPerMinute: null,
        cadenceStepsPerMinute: null,
        elevationGainMeters: null,
      },
    ],
  })
  const result = await getActivityDetail(owner, id)
  expect(result).toMatchObject({
    title: 'Saved run',
    distanceMeters: 4000,
    timerMs: 1200_000,
    fitAvailability: 'NOT_CONNECTED',
    laps: [{ index: 0, timerMs: 300_000, avgPowerWatts: 200 }],
  })
  const args = db.activity.findFirst.mock.calls[0][0]
  expect(args.where.AND[0].userId).toBe(owner.userId)
  expect(args.select.laps.where).toEqual({ userId: owner.userId })
  expect(args.select.laps.orderBy).toEqual({ lapIndex: 'asc' })
  expect(args.select).not.toHaveProperty('rawObjectRef')
  expect(args.select).not.toHaveProperty('gpsAssetRef')
})
it('treats another owner and missing activities identically and rejects unsafe IDs', async () => {
  db.activity.findFirst.mockResolvedValue(null)
  expect(await getActivityDetail(other, id)).toBeNull()
  expect(db.activity.findFirst.mock.calls[0][0].where.AND[0].userId).toBe(other.userId)
  await expect(getActivityDetail(owner, '../bad')).rejects.toThrow()
  expect(db.activity.findFirst).toHaveBeenCalledOnce()
})
