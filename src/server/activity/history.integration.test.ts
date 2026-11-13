import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
import { getPrismaClient } from '@/server/db/client'
import { getOwnerContext } from '@/server/authorization/ownership'
import { getActivityHistory } from './history'
import { getActivityDetail } from './detail'
import { disconnectProvider, saveProviderApiKey } from '@/server/provider/vault'

const requested = process.env.npm_lifecycle_event === 'test:db'
if (requested) config()
const enabled =
  requested &&
  ['development', 'test'].includes(process.env.APP_DATABASE_ENV ?? '') &&
  Boolean(process.env.DATABASE_URL && process.env.DIRECT_URL) &&
  !process.env.VERCEL_ENV
if (requested && !enabled)
  throw new Error('test:db requires isolated development/test database URLs')

describe.skipIf(!enabled)('activity history on isolated PostgreSQL', () => {
  let prisma: PrismaClient
  let owner: ReturnType<typeof getOwnerContext>
  let other: ReturnType<typeof getOwnerContext>
  const prefix = `run44-${randomUUID()}`
  beforeAll(async () => {
    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1'
    process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = Buffer.alloc(32, 44).toString('base64')
    prisma = await getPrismaClient()
    const a = await prisma.user.create({ data: { authSubject: `${prefix}-a` } })
    const b = await prisma.user.create({ data: { authSubject: `${prefix}-b`, role: 'ADMIN' } })
    owner = getOwnerContext({ id: a.id, role: 'USER', email: null })
    other = getOwnerContext({ id: b.id, role: 'ADMIN', email: null })
    await prisma.athleteProfile.create({ data: { userId: a.id, preferredTimezone: 'Asia/Tokyo' } })
    await saveProviderApiKey(owner, 'GARMIN', 'synthetic-run44-key', {
      verifiedGarminAccountId: '444444',
    })
    const date = new Date('2026-11-11T16:00:00Z')
    await prisma.activity.createMany({
      data: Array.from({ length: 24 }, (_, index) => ({
        userId: a.id,
        sourceProvider: index % 2 ? ('GARMIN' as const) : ('FILE' as const),
        garminAccountId: index % 2 ? '444444' : 'LEGACY_UNVERIFIED',
        externalActivityId: String(index),
        sportType: index % 3 ? 'RUNNING' : 'WALKING',
        activityTitle: index === 1 ? '100% Trail run' : `Trail outing ${index}`,
        startedAt: date,
        listStartedAt: date,
        distanceMeters: index < 12 ? 5000 : null,
        totalMs: index < 12 ? BigInt(1800000) : null,
        avgHrBpm: index < 12 ? 150 : null,
      })),
    })
    await prisma.activity.createMany({
      data: [
        {
          userId: b.id,
          sourceProvider: 'FILE',
          sportType: 'SWIMMING',
          activityTitle: 'Other athlete secret',
          startedAt: new Date('2010-01-01T00:00:00Z'),
          listStartedAt: date,
        },
        {
          userId: a.id,
          sourceProvider: 'GARMIN',
          garminAccountId: 'LEGACY_UNVERIFIED',
          sportType: 'RUNNING',
          activityTitle: 'Unverified account',
          startedAt: new Date('2000-01-01T00:00:00Z'),
          listStartedAt: date,
        },
      ],
    })
  }, 30000)
  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({ where: { authSubject: { startsWith: prefix } } })
      await prisma.$disconnect()
    }
    delete process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_V1
  })
  it('paginates equal timestamps deterministically without duplicates or another owner', async () => {
    const first = await getActivityHistory(owner, {})
    const second = await getActivityHistory(owner, { page: 2 })
    const third = await getActivityHistory(owner, { page: 3 })
    expect(first).toMatchObject({
      total: 24,
      pageCount: 3,
      sports: ['RUNNING', 'WALKING'],
      providers: ['GARMIN', 'FILE'],
    })
    expect(
      new Set([...first.items, ...second.items, ...third.items].map((row) => row.id)).size,
    ).toBe(24)
    expect((await getActivityHistory(owner, {})).items).toEqual(first.items)
    expect(await getActivityHistory(other, {})).toMatchObject({ total: 1, sports: ['SWIMMING'] })
    expect(
      first.items.some(
        (row) => row.title?.includes('secret') || row.title === 'Unverified account',
      ),
    ).toBe(false)
    const oldest = await getActivityHistory(owner, { sort: 'oldest', pageSize: 50 })
    expect(oldest.items.map((row) => row.id)).toEqual(
      [...first.items, ...second.items, ...third.items].map((row) => row.id).reverse(),
    )
  })
  it('composes literal title, sport, provider, local dates, distance and HR filters', async () => {
    const result = await getActivityHistory(owner, {
      q: '100%',
      sport: 'RUNNING',
      provider: 'GARMIN',
      range: 'custom',
      from: '2026-11-12',
      to: '2026-11-12',
      minDistance: 5,
    })
    expect(result.total).toBe(1)
    expect(result.items[0]).toMatchObject({
      title: '100% Trail run',
      distanceMeters: 5000,
      timerMs: 1800000,
      avgHrBpm: 150,
    })
    expect((await getActivityHistory(owner, { range: 'custom', to: '2026-11-11' })).total).toBe(0)
    const all = await getActivityHistory(owner, { pageSize: 50 })
    expect(
      all.items.some(
        (row) => row.distanceMeters === null && row.timerMs === null && row.avgHrBpm === null,
      ),
    ).toBe(true)
  })
  it('retains verified saved history after disconnect without requesting Garmin', async () => {
    await disconnectProvider(owner, 'GARMIN')
    const saved = await getActivityHistory(owner, {})
    expect(saved.total).toBe(24)
    expect(saved.providers).toContain('GARMIN')
    expect((await getActivityHistory(other, { q: 'Trail' })).total).toBe(0)
  })

  it('bounds calendars by visible saved history independently of active filters or older private rows', async () => {
    const result = await getActivityHistory(
      owner,
      { q: 'Unmatched title' },
      { now: new Date('2026-11-12T00:00:00Z'), timezone: 'Asia/Tokyo' },
    )
    expect(result.total).toBe(0)
    expect(result.dateBounds).toEqual({ min: '2026-11-12', max: '2026-11-12' })
    expect(
      (
        await getActivityHistory(
          other,
          {},
          {
            now: new Date('2026-11-12T00:00:00Z'),
            timezone: 'Asia/Tokyo',
          },
        )
      ).dateBounds.min,
    ).toBe('2010-01-01')
  })

  it('serves private saved detail and laps after disconnect, with no administrative data bypass', async () => {
    const saved = await prisma.activity.findFirstOrThrow({
      where: { userId: owner.userId, sourceProvider: 'GARMIN', garminAccountId: '444444' },
    })
    await prisma.activityLap.createMany({
      data: [2, 0].map((lapIndex) => ({
        userId: owner.userId,
        activityId: saved.id,
        lapIndex,
        sourceRecordType: 'FIT_LAP',
        distanceMeters: 1000,
        timerMs: BigInt(300_000),
        avgPowerWatts: 200,
      })),
    })
    const detail = await getActivityDetail(owner, saved.id)
    expect(detail).toMatchObject({ id: saved.id, fitAvailability: 'NOT_CONNECTED' })
    expect(await getActivityDetail(other, saved.id)).toBeNull()
    const legacy = await prisma.activity.findFirstOrThrow({
      where: { userId: owner.userId, activityTitle: 'Unverified account' },
    })
    expect(await getActivityDetail(owner, legacy.id)).toBeNull()
    expect(detail).not.toHaveProperty('garminAccountId')
    expect(detail).not.toHaveProperty('rawObjectRef')
    expect(detail?.laps.map((lap) => lap.index)).toEqual([0, 2])
    expect(detail?.laps[0]).toMatchObject({
      distanceMeters: 1000,
      timerMs: 300_000,
      avgPowerWatts: 200,
    })
  })

  it('excludes a marathon from Ultra and applies browser-local dates independently of the profile', async () => {
    const startedAt = new Date('2026-11-11T16:00:00Z')
    await prisma.activity.createMany({
      data: [
        {
          userId: owner.userId,
          sourceProvider: 'FILE',
          sportType: 'RUNNING',
          activityTitle: 'Marathon boundary',
          externalActivityId: 'marathon',
          startedAt,
          listStartedAt: startedAt,
          distanceMeters: 42195,
        },
        {
          userId: owner.userId,
          sourceProvider: 'FILE',
          sportType: 'RUNNING',
          activityTitle: 'Ultra boundary',
          externalActivityId: 'ultra',
          startedAt,
          listStartedAt: startedAt,
          distanceMeters: 42195.001,
        },
      ],
    })
    expect(
      (await getActivityHistory(owner, { sport: 'RUNNING', minDistance: '42.195' })).total,
    ).toBe(2)
    const ultra = await getActivityHistory(owner, { sport: 'RUNNING', minDistance: 'ultra' })
    expect(ultra.items.map((row) => row.title)).toEqual(['Ultra boundary'])
    const localDate = { q: 'boundary', range: 'custom', from: '2026-11-12', to: '2026-11-12' }
    expect((await getActivityHistory(owner, localDate, { timezone: 'Asia/Tokyo' })).total).toBe(2)
    expect(
      (await getActivityHistory(owner, localDate, { timezone: 'America/Los_Angeles' })).total,
    ).toBe(0)
    expect(
      (await getActivityHistory(other, { sport: 'RUNNING', minDistance: 'ultra' })).total,
    ).toBe(0)
  })
})
