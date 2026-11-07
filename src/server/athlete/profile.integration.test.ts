import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { getPrismaClient } from '@/server/db/client'
import {
  addWeight,
  getAthleteSettings,
  getWeightChartReadings,
  getWeightHistoryPage,
  SexRequiredError,
  updateAthleteProfile,
} from './profile'

vi.mock('server-only', () => ({}))

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
    await expect(updateAthleteProfile(a.id, { heightCm: 172 })).rejects.toBeInstanceOf(
      SexRequiredError,
    )
    await updateAthleteProfile(a.id, {
      sex: 'FEMALE',
      heightCm: 172,
      measurementSystem: 'IMPERIAL',
      defaultTrainingDaysPerWeek: 3,
    })
    await updateAthleteProfile(a.id, { defaultTrainingDaysPerWeek: 4 })
    const firstRequestId = randomUUID()
    const measuredOn = new Date().toISOString().slice(0, 10)
    const firstInput = {
      value: 70,
      unit: 'KG' as const,
      measuredOn,
      timezoneOffsetMinutes: 0,
      requestId: firstRequestId,
    }
    const first = await addWeight(a.id, firstInput)
    const retry = await addWeight(a.id, firstInput)
    expect(retry.id).toBe(first.id)
    expect(first.measuredOn?.toISOString().slice(0, 10)).toBe(measuredOn)
    await addWeight(a.id, { value: 71, unit: 'KG', requestId: randomUUID() })
    const own = await getAthleteSettings(a.id)
    const other = await getAthleteSettings(b.id)
    expect(own.profile).toMatchObject({
      heightCm: 172,
      experienceLevel: 'BEGINNER',
      measurementSystem: 'IMPERIAL',
      defaultTrainingDaysPerWeek: 4,
    })
    expect(own.weights.map((weight) => weight.valueKg).sort()).toEqual([70, 71])
    expect(own.weights.find((weight) => weight.id === first.id)?.measuredOn).toBe(measuredOn)
    expect(
      (await getWeightHistoryPage(a.id, 1)).items.map((weight) => weight.valueKg).sort(),
    ).toEqual([70, 71])
    expect(
      (await getWeightChartReadings(a.id, 'ALL')).map((weight) => weight.valueKg).sort(),
    ).toEqual([70, 71])
    expect((await getWeightHistoryPage(b.id, 1)).items).toEqual([])
    expect(other.profile.heightCm).toBeNull()
    expect(other.profile.experienceLevel).toBe('BEGINNER')
    expect(other.profile.measurementSystem).toBe('METRIC')
    expect(other.weights).toEqual([])
    await addWeight(b.id, { value: 72, unit: 'KG', requestId: firstRequestId })
    expect((await getAthleteSettings(b.id)).weights.map((weight) => weight.valueKg)).toEqual([72])
    await updateAthleteProfile(b.id, { measurementSystem: 'IMPERIAL' })
    expect((await getAthleteSettings(b.id)).profile).toMatchObject({
      sex: null,
      measurementSystem: 'IMPERIAL',
    })
    expect(await prisma.bodyMeasurement.count({ where: { userId: a.id } })).toBe(2)
  }, 30_000)
})
