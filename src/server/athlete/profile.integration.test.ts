import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { GET as getWeight, POST as postWeight } from '@/app/api/athlete/weight/route'
import { PATCH as patchProfile } from '@/app/api/athlete/profile/route'
import {
  getOwnerContext,
  InvalidOwnerContextError,
  ownedIdWhere,
  ownedWhere,
  OwnedResourceNotFoundError,
  requireOwnedConnection,
} from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import {
  addWeight,
  getAthleteSettings,
  getWeightChartReadings,
  getWeightHistoryPage,
  SexRequiredError,
  updateAthleteProfile,
} from './profile'

const { getCurrentUser, isVerifiedCurrentUser } = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  isVerifiedCurrentUser: vi.fn(() => true),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({
  AccountUnavailableError: class AccountUnavailableError extends Error {},
  getCurrentUser,
  isVerifiedCurrentUser,
}))

const databaseTestRequested = process.env.npm_lifecycle_event === 'test:db'
if (databaseTestRequested) config()
const runDatabaseTest =
  databaseTestRequested &&
  (process.env.APP_DATABASE_ENV === 'test' || process.env.APP_DATABASE_ENV === 'development') &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.DIRECT_URL) &&
  !process.env.VERCEL_ENV

if (databaseTestRequested && !runDatabaseTest)
  throw new Error('test:db requires isolated development/test DATABASE_URL and DIRECT_URL')

describe.skipIf(!runDatabaseTest)('athlete settings on isolated PostgreSQL', () => {
  let prisma: PrismaClient | null = null
  const prefix = `run-19-${randomUUID()}`

  beforeAll(async () => {
    prisma = await getPrismaClient()
  }, 30_000)
  afterAll(async () => {
    if (!prisma) return
    await prisma.user.deleteMany({ where: { authSubject: { startsWith: prefix } } })
    await prisma.$disconnect()
  })

  it('keeps profiles and weight readings separate across owners', async () => {
    if (!prisma) throw new Error('An isolated test database is required')
    const a = await prisma.user.create({ data: { authSubject: `${prefix}-a` } })
    const b = await prisma.user.create({ data: { authSubject: `${prefix}-b` } })
    const ownerA = getOwnerContext({ id: a.id, role: 'USER', email: null })
    const ownerB = getOwnerContext({ id: b.id, role: 'USER', email: null })
    await expect(updateAthleteProfile(ownerA, { heightCm: 172 })).rejects.toBeInstanceOf(
      SexRequiredError,
    )
    await updateAthleteProfile(ownerA, {
      sex: 'FEMALE',
      heightCm: 172,
      measurementSystem: 'IMPERIAL',
      defaultTrainingDaysPerWeek: 3,
    })
    await updateAthleteProfile(ownerA, { defaultTrainingDaysPerWeek: 4 })
    const firstRequestId = randomUUID()
    const measuredOn = new Date().toISOString().slice(0, 10)
    const firstInput = {
      value: 70,
      unit: 'KG' as const,
      measuredOn,
      timezoneOffsetMinutes: 0,
      requestId: firstRequestId,
    }
    const first = await addWeight(ownerA, firstInput)
    const retry = await addWeight(ownerA, firstInput)
    expect(retry.id).toBe(first.id)
    expect(first.measuredOn?.toISOString().slice(0, 10)).toBe(measuredOn)
    await addWeight(ownerA, { value: 71, unit: 'KG', requestId: randomUUID() })
    const own = await getAthleteSettings(ownerA)
    const other = await getAthleteSettings(ownerB)
    expect(own.profile).toMatchObject({
      heightCm: 172,
      experienceLevel: 'BEGINNER',
      measurementSystem: 'IMPERIAL',
      defaultTrainingDaysPerWeek: 4,
    })
    expect(own.weights.map((weight) => weight.valueKg).sort()).toEqual([70, 71])
    expect(own.weights.find((weight) => weight.id === first.id)?.measuredOn).toBe(measuredOn)
    expect(
      (await getWeightHistoryPage(ownerA, 1)).items.map((weight) => weight.valueKg).sort(),
    ).toEqual([70, 71])
    expect(
      (await getWeightChartReadings(ownerA, 'ALL')).map((weight) => weight.valueKg).sort(),
    ).toEqual([70, 71])
    expect((await getWeightHistoryPage(ownerB, 1)).items).toEqual([])
    expect(other.profile.heightCm).toBeNull()
    expect(other.profile.experienceLevel).toBe('BEGINNER')
    expect(other.profile.measurementSystem).toBe('METRIC')
    expect(other.weights).toEqual([])
    const otherReading = await addWeight(ownerB, {
      value: 72,
      unit: 'KG',
      requestId: firstRequestId,
    })
    expect((await getAthleteSettings(ownerB)).weights.map((weight) => weight.valueKg)).toEqual([72])
    await updateAthleteProfile(ownerB, { measurementSystem: 'IMPERIAL' })
    expect((await getAthleteSettings(ownerB)).profile).toMatchObject({
      sex: null,
      measurementSystem: 'IMPERIAL',
    })
    expect(await prisma.bodyMeasurement.count({ where: { userId: ownerA.userId } })).toBe(2)

    await expect(getAthleteSettings({ userId: ownerB.userId })).rejects.toBeInstanceOf(
      InvalidOwnerContextError,
    )

    // Exercise the production route, session resolver and service together.
    await prisma.user.update({ where: { id: ownerA.userId }, data: { role: 'ADMIN' } })
    getCurrentUser.mockResolvedValue({ id: a.id, role: 'ADMIN' })
    const history = await getWeight(
      new Request(
        `https://coach.example.test/api/athlete/weight?view=history&page=1&userId=${b.id}`,
      ),
    )
    expect(history.status).toBe(200)
    const historyBody: unknown = await history.json()
    expect(historyBody).toMatchObject({ total: 2 })
    expect(JSON.stringify(historyBody)).not.toContain(otherReading.id)

    const forgedPatch = await patchProfile(
      new Request('https://coach.example.test/api/athlete/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: b.id, measurementSystem: 'METRIC' }),
      }),
    )
    expect(forgedPatch.status).toBe(400)
    const forgedWeight = await postWeight(
      new Request('https://coach.example.test/api/athlete/weight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: b.id, value: 99, unit: 'KG', requestId: randomUUID() }),
      }),
    )
    expect(forgedWeight.status).toBe(400)
    expect(await prisma.bodyMeasurement.count({ where: { userId: ownerB.userId } })).toBe(1)

    const ownPatch = await patchProfile(
      new Request('https://coach.example.test/api/athlete/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ measurementSystem: 'METRIC' }),
      }),
    )
    expect(ownPatch.status).toBe(204)
    expect((await getAthleteSettings(ownerA)).profile.measurementSystem).toBe('METRIC')
    expect((await getAthleteSettings(ownerB)).profile.measurementSystem).toBe('IMPERIAL')

    const ownWeight = await postWeight(
      new Request('https://coach.example.test/api/athlete/weight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 73, unit: 'KG', requestId: randomUUID() }),
      }),
    )
    expect(ownWeight.status).toBe(201)
    expect(await prisma.bodyMeasurement.count({ where: { userId: ownerA.userId } })).toBe(3)
    expect(await prisma.bodyMeasurement.count({ where: { userId: ownerB.userId } })).toBe(1)

    // Guessed child IDs must remain inaccessible in detail, mutation and
    // projected-list queries, including when the caller has the ADMIN role.
    expect(
      await prisma.bodyMeasurement.findFirst({ where: ownedIdWhere(ownerA, otherReading.id) }),
    ).toBeNull()
    expect(
      await prisma.bodyMeasurement.updateMany({
        where: ownedIdWhere(ownerA, otherReading.id),
        data: { value: 99 },
      }),
    ).toMatchObject({ count: 0 })
    expect(
      (
        await prisma.bodyMeasurement.findMany({
          where: ownedWhere(ownerA, {}),
          select: { id: true },
        })
      ).map((row) => row.id),
    ).not.toContain(otherReading.id)
    const unchanged = await prisma.bodyMeasurement.findUnique({ where: { id: otherReading.id } })
    expect(unchanged?.userId).toBe(ownerB.userId)
    expect(unchanged?.value.toNumber()).toBe(72)

    const otherConnection = await prisma.integrationConnection.create({
      data: { userId: ownerB.userId, provider: 'GARMIN', authMethod: 'OAUTH' },
    })
    const ownConnection = await prisma.integrationConnection.create({
      data: { userId: ownerA.userId, provider: 'GARMIN', authMethod: 'OAUTH' },
    })
    await expect(requireOwnedConnection(ownerA, ownConnection.id)).resolves.toEqual({
      id: ownConnection.id,
    })
    await expect(requireOwnedConnection(ownerA, otherConnection.id)).rejects.toBeInstanceOf(
      OwnedResourceNotFoundError,
    )
  }, 30_000)
})
