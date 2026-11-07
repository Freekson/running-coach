import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'

const { getPrismaClient, findUnique, findMany, count, upsert, create, findMeasurement } =
  vi.hoisted(() => ({
    getPrismaClient: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    upsert: vi.fn(),
    create: vi.fn(),
    findMeasurement: vi.fn(),
  }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/db/client', () => ({ getPrismaClient }))

import {
  addWeight,
  getAthleteSettings,
  getWeightChartReadings,
  getWeightHistoryPage,
  getMeasurementSystem,
  profilePatchSchema,
  SexRequiredError,
  updateAthleteProfile,
  WeightRequestConflictError,
  weightInputSchema,
} from './profile'

beforeEach(() => {
  vi.clearAllMocks()
  findUnique.mockResolvedValue({ sex: 'FEMALE' })
  getPrismaClient.mockResolvedValue({
    athleteProfile: { findUnique, upsert },
    bodyMeasurement: { findMany, count, create, findUnique: findMeasurement },
  })
})

describe('athlete profile', () => {
  it('reads only the authenticated owner profile and weight history', async () => {
    findUnique.mockResolvedValue(null)
    findMany.mockResolvedValue([])
    expect((await getAthleteSettings('athlete-a')).profile.experienceLevel).toBe('BEGINNER')
    expect((await getAthleteSettings('athlete-b')).profile.experienceLevel).toBe('BEGINNER')
    expect(findUnique.mock.calls.map(([args]) => args.where.userId)).toEqual([
      'athlete-a',
      'athlete-b',
    ])
    expect(findMany.mock.calls.map(([args]) => args.where.userId)).toEqual([
      'athlete-a',
      'athlete-a',
      'athlete-b',
      'athlete-b',
    ])
    expect(findMany.mock.calls.every(([args]) => args.where.measurementType === 'WEIGHT')).toBe(
      true,
    )
  })

  it('loads seven days by default and the requested period when supplied', async () => {
    findMany.mockResolvedValue([])
    await getAthleteSettings('athlete-a')
    expect(findMany.mock.calls[1][0].where.measuredAt.gte).toBeInstanceOf(Date)

    await getAthleteSettings('athlete-a', 'ALL')
    expect(findMany.mock.calls[3][0].where.measuredAt).toBeUndefined()
  })

  it('reads the account-wide measurement system for each owner', async () => {
    findUnique.mockResolvedValueOnce({ measurementSystem: 'IMPERIAL' }).mockResolvedValueOnce(null)
    await expect(getMeasurementSystem('athlete-a')).resolves.toBe('IMPERIAL')
    await expect(getMeasurementSystem('athlete-b')).resolves.toBe('METRIC')
    expect(findUnique.mock.calls.map(([args]) => args.where.userId)).toEqual([
      'athlete-a',
      'athlete-b',
    ])
  })

  it('paginates full history and loads chart readings with owner-scoped deterministic order', async () => {
    count.mockResolvedValue(25)
    findMany.mockResolvedValue([
      {
        id: 'reading-a',
        measuredAt: new Date('2026-11-05T12:00:00Z'),
        measuredOn: new Date('2026-11-07T00:00:00Z'),
        createdAt: new Date('2026-11-07T12:00:00Z'),
        value: new Prisma.Decimal(70),
      },
    ])
    const page = await getWeightHistoryPage('athlete-a', 2)
    expect(page).toMatchObject({
      page: 2,
      pageSize: 5,
      total: 25,
      totalPages: 5,
      items: [{ id: 'reading-a', measuredOn: '2026-11-07', valueKg: 70 }],
    })
    expect(count).toHaveBeenCalledWith({
      where: { userId: 'athlete-a', measurementType: 'WEIGHT' },
    })
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: { userId: 'athlete-a', measurementType: 'WEIGHT' },
      orderBy: [{ measuredAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      skip: 5,
      take: 5,
    })
    await getWeightChartReadings('athlete-b', 'ALL')
    expect(findMany.mock.calls[1][0]).toMatchObject({
      where: { userId: 'athlete-b', measurementType: 'WEIGHT' },
      orderBy: [{ measuredAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    })
    expect(findMany.mock.calls[1][0].where.measuredAt).toBeUndefined()
    await getWeightChartReadings('athlete-a', '7D')
    expect(findMany.mock.calls[2][0].where).toMatchObject({
      userId: 'athlete-a',
      measuredAt: { gte: expect.any(Date) },
    })
  })

  it('preserves a previously selected training experience', async () => {
    findUnique.mockResolvedValue({ experienceLevel: 'ADVANCED' })
    findMany.mockResolvedValue([])
    expect((await getAthleteSettings('athlete-a')).profile.experienceLevel).toBe('ADVANCED')
  })

  it('saves measurement units independently of sex', async () => {
    findUnique.mockResolvedValue(null)
    await updateAthleteProfile('athlete-a', { measurementSystem: 'IMPERIAL' })
    expect(upsert.mock.calls[0][0].update).toMatchObject({ measurementSystem: 'IMPERIAL' })
    expect(findUnique).not.toHaveBeenCalled()
  })

  it('updates only supplied optional fields and leaves approved plans untouched', async () => {
    const patch = profilePatchSchema.parse({ defaultTrainingDaysPerWeek: 4 })
    await updateAthleteProfile('athlete-a', patch)
    expect(upsert).toHaveBeenCalledWith({
      where: { userId: 'athlete-a' },
      create: expect.objectContaining({ userId: 'athlete-a', defaultTrainingDaysPerWeek: 4 }),
      update: expect.objectContaining({ userId: 'athlete-a', defaultTrainingDaysPerWeek: 4 }),
    })
    expect(upsert.mock.calls[0][0].update).not.toHaveProperty('heightCm')
    expect(upsert.mock.calls[0][0].update).not.toHaveProperty('displayName')
  })

  it('clears optional values, including a nullable weekday preference', async () => {
    await updateAthleteProfile('athlete-a', {
      birthDate: null,
      defaultAvailableWeekdays: null,
    })
    expect(upsert.mock.calls[0][0].update).toMatchObject({
      birthDate: null,
      defaultAvailableWeekdays: Prisma.DbNull,
    })
  })

  it('requires a male or female choice before the first profile save', async () => {
    findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ sex: null })
    await expect(updateAthleteProfile('athlete-a', { heightCm: 170 })).rejects.toBeInstanceOf(
      SexRequiredError,
    )
    await expect(updateAthleteProfile('athlete-a', { heightCm: 170 })).rejects.toBeInstanceOf(
      SexRequiredError,
    )
    expect(upsert).not.toHaveBeenCalled()
    await updateAthleteProfile('athlete-a', { sex: 'MALE', heightCm: 170 })
    expect(upsert.mock.calls[0][0].create).toMatchObject({
      userId: 'athlete-a',
      sex: 'MALE',
      heightCm: 170,
    })
  })

  it('rejects unexpected fields, invalid dates and duplicate weekdays while allowing nullable height', () => {
    expect(profilePatchSchema.safeParse({ userId: 'athlete-b' }).success).toBe(false)
    expect(profilePatchSchema.safeParse({ birthDate: '2025-02-30' }).success).toBe(false)
    expect(profilePatchSchema.safeParse({ preferredTimezone: 'Asia/Tokyo' }).success).toBe(false)
    expect(profilePatchSchema.safeParse({ heightCm: null }).success).toBe(true)
    expect(profilePatchSchema.safeParse({ defaultAvailableWeekdays: [1, 1] }).success).toBe(false)
    expect(profilePatchSchema.safeParse({}).success).toBe(false)
    expect(profilePatchSchema.safeParse({ displayName: null }).success).toBe(true)
    expect(profilePatchSchema.safeParse({ sex: null }).success).toBe(false)
    expect(profilePatchSchema.safeParse({ sex: 'OTHER' }).success).toBe(false)
    expect(profilePatchSchema.safeParse({ experienceLevel: null }).success).toBe(false)
    expect(profilePatchSchema.safeParse({ experienceLevel: 'ADVANCED' }).success).toBe(true)
    expect(profilePatchSchema.safeParse({ measurementSystem: 'IMPERIAL' }).success).toBe(true)
    expect(profilePatchSchema.safeParse({ measurementSystem: 'OTHER' }).success).toBe(false)
    expect(profilePatchSchema.safeParse({ distanceUnit: 'MI' }).success).toBe(false)
    expect(profilePatchSchema.safeParse({ weightUnit: 'LB' }).success).toBe(false)
    expect(
      weightInputSchema.safeParse({
        value: 70,
        unit: 'KG',
        measuredOn: '2025-02-30',
        requestId: '969e52dd-3b4f-48ce-935a-3ad674584a24',
      }).success,
    ).toBe(false)
  })

  it('appends distinct manual readings and converts pounds to canonical kilograms', async () => {
    create.mockImplementation(async ({ data }) => ({
      id: 'new',
      measuredAt: data.measuredAt,
      value: data.value,
    }))
    await addWeight(
      'athlete-a',
      weightInputSchema.parse({
        value: 100,
        unit: 'LB',
        requestId: '969e52dd-3b4f-48ce-935a-3ad674584a24',
      }),
    )
    await addWeight(
      'athlete-a',
      weightInputSchema.parse({
        value: 70,
        unit: 'KG',
        requestId: 'd918c356-ae38-4ac6-8196-97d21a6742f1',
      }),
    )
    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[0][0].data).toMatchObject({
      userId: 'athlete-a',
      measurementType: 'WEIGHT',
      value: 45.36,
      unit: 'KG',
      source: 'MANUAL',
      sourceExternalId: '969e52dd-3b4f-48ce-935a-3ad674584a24',
    })
    expect(create.mock.calls[1][0].data.value).toBe(70)
    expect(create.mock.calls[0][0].data.measuredAt).toBeInstanceOf(Date)
  })

  it('stores the selected measurement date and rejects a retry with another date', async () => {
    create.mockImplementation(async ({ data }) => ({
      id: 'new',
      measuredAt: data.measuredAt,
      value: data.value,
    }))
    const requestId = '969e52dd-3b4f-48ce-935a-3ad674584a24'
    await addWeight('athlete-a', { value: 70, unit: 'KG', measuredOn: '2026-11-05', requestId })
    expect(create.mock.calls[0][0].data.measuredAt.toISOString()).toBe('2026-11-05T12:00:00.000Z')
    create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '6.19.0',
      }),
    )
    findMeasurement.mockResolvedValue({
      id: 'old',
      measuredAt: new Date('2026-11-05T12:00:00.000Z'),
      value: new Prisma.Decimal(70),
      unit: 'KG',
      measurementType: 'WEIGHT',
    })
    await expect(
      addWeight('athlete-a', { value: 70, unit: 'KG', measuredOn: '2026-11-06', requestId }),
    ).rejects.toBeInstanceOf(WeightRequestConflictError)
  })

  it('stores local noon for a weight date and checks retries against the same instant', async () => {
    const requestId = '969e52dd-3b4f-48ce-935a-3ad674584a24'
    create.mockResolvedValue({ id: 'new' })
    const input = {
      value: 70,
      unit: 'KG' as const,
      measuredOn: '2026-11-05',
      timezoneOffsetMinutes: 540,
      requestId,
    }
    await addWeight('athlete-a', input)
    expect(create.mock.calls[0][0].data.measuredAt.toISOString()).toBe('2026-11-05T21:00:00.000Z')
    expect(create.mock.calls[0][0].data.measuredOn.toISOString()).toBe('2026-11-05T00:00:00.000Z')

    create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '6.19.0',
      }),
    )
    findMeasurement.mockResolvedValue({
      id: 'old',
      measuredAt: new Date('2026-11-05T21:00:00.000Z'),
      measuredOn: new Date('2026-11-05T00:00:00.000Z'),
      value: new Prisma.Decimal(70),
      unit: 'KG',
      measurementType: 'WEIGHT',
    })
    await expect(addWeight('athlete-a', input)).resolves.toMatchObject({ id: 'old' })
    await expect(
      addWeight('athlete-a', { ...input, timezoneOffsetMinutes: 0 }),
    ).rejects.toBeInstanceOf(WeightRequestConflictError)
  })

  it('accepts a retry for a pre-migration reading without measured_on', async () => {
    create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '6.19.0',
      }),
    )
    findMeasurement.mockResolvedValue({
      id: 'legacy-reading',
      measuredAt: new Date('2026-11-05T21:00:00.000Z'),
      measuredOn: null,
      value: new Prisma.Decimal(70),
      unit: 'KG',
      measurementType: 'WEIGHT',
    })
    await expect(
      addWeight('athlete-a', {
        value: 70,
        unit: 'KG',
        measuredOn: '2026-11-05',
        timezoneOffsetMinutes: 540,
        requestId: '969e52dd-3b4f-48ce-935a-3ad674584a24',
      }),
    ).resolves.toMatchObject({ id: 'legacy-reading' })
  })

  it('rejects an undated retry of a dated reading with the same request ID', async () => {
    create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '6.19.0',
      }),
    )
    findMeasurement.mockResolvedValue({
      id: 'dated-reading',
      measuredAt: new Date('2026-11-05T21:00:00.000Z'),
      measuredOn: new Date('2026-11-05T00:00:00.000Z'),
      value: new Prisma.Decimal(70),
      unit: 'KG',
      measurementType: 'WEIGHT',
    })
    await expect(
      addWeight('athlete-a', {
        value: 70,
        unit: 'KG',
        requestId: '969e52dd-3b4f-48ce-935a-3ad674584a24',
      }),
    ).rejects.toBeInstanceOf(WeightRequestConflictError)
  })

  it('returns the existing owner-scoped reading when a request ID is retried', async () => {
    const requestId = '969e52dd-3b4f-48ce-935a-3ad674584a24'
    const duplicate = new Prisma.PrismaClientKnownRequestError('duplicate measurement', {
      code: 'P2002',
      clientVersion: '6.19.0',
    })
    create.mockRejectedValue(duplicate)
    const existing = {
      id: 'reading-a',
      measuredAt: new Date('2026-11-07T00:00:00Z'),
      measuredOn: null,
      value: new Prisma.Decimal(70),
      unit: 'KG',
      measurementType: 'WEIGHT',
    }
    findMeasurement.mockResolvedValue(existing)
    await expect(addWeight('athlete-a', { value: 70, unit: 'KG', requestId })).resolves.toBe(
      existing,
    )
    expect(findMeasurement).toHaveBeenCalledWith({
      where: {
        userId_source_sourceExternalId: {
          userId: 'athlete-a',
          source: 'MANUAL',
          sourceExternalId: requestId,
        },
      },
      select: {
        id: true,
        measuredAt: true,
        measuredOn: true,
        createdAt: true,
        value: true,
        unit: true,
        measurementType: true,
      },
    })
    findMeasurement.mockResolvedValue({ ...existing, value: new Prisma.Decimal(71) })
    await expect(addWeight('athlete-a', { value: 70, unit: 'KG', requestId })).rejects.toThrow(
      'already used',
    )
  })
})
