import 'server-only'

import { Prisma, type AthleteProfile } from '@prisma/client'
import { z } from 'zod'
import { getPrismaClient } from '@/server/db/client'
import { ownedWhere, ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { normalizeMeasurementSystem, type MeasurementSystem } from '@/lib/measurement-system'

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`)
    return (
      !Number.isNaN(date.getTime()) &&
      date.toISOString().slice(0, 10) === value &&
      date <= new Date(Date.now() + 14 * 60 * 60 * 1000)
    )
  }, 'Enter a valid current or past date')

const experienceLevel = z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED'])

export const profilePatchSchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(120).nullable().optional(),
    birthDate: dateOnly.nullable().optional(),
    sex: z.enum(['MALE', 'FEMALE']).optional(),
    heightCm: z.number().min(50).max(300).nullable().optional(),
    experienceLevel: experienceLevel.optional(),
    measurementSystem: z.enum(['METRIC', 'IMPERIAL']).optional(),
    defaultTrainingDaysPerWeek: z.number().int().min(1).max(7).nullable().optional(),
    defaultAvailableWeekdays: z
      .array(z.number().int().min(0).max(6))
      .max(7)
      .refine((days) => new Set(days).size === days.length, 'Choose each weekday only once')
      .nullable()
      .optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'Choose at least one field')

export const weightInputSchema = z.strictObject({
  value: z.number().min(0.1).max(1000),
  unit: z.enum(['KG', 'LB']),
  measuredOn: dateOnly.optional(),
  timezoneOffsetMinutes: z.number().int().min(-840).max(720).optional(),
  requestId: z.uuid(),
})

export const weightChartPeriodSchema = z.enum(['7D', '30D', '90D', '1Y', 'ALL'])
export const weightHistoryPageSchema = z.coerce.number().int().min(1).max(100_000)
export const weightHistoryPageSize = 5
export type WeightChartPeriod = z.infer<typeof weightChartPeriodSchema>

const weightOrder: Prisma.BodyMeasurementOrderByWithRelationInput[] = [
  { measuredAt: 'desc' },
  { createdAt: 'desc' },
  { id: 'desc' },
]
const weightSelect = {
  id: true,
  measuredAt: true,
  measuredOn: true,
  createdAt: true,
  value: true,
} as const

function weightCutoff(period: WeightChartPeriod) {
  if (period === 'ALL') return undefined
  const days = { '7D': 7, '30D': 30, '90D': 90, '1Y': 365 }[period]
  // Two extra days cover the user's local calendar boundary at either UTC extreme.
  return new Date(Date.now() - (days + 2) * 86_400_000)
}

function serializeWeight(item: {
  id: string
  measuredAt: Date
  measuredOn: Date | null
  createdAt: Date
  value: Prisma.Decimal
}) {
  return {
    id: item.id,
    measuredAt: item.measuredAt.toISOString(),
    measuredOn: item.measuredOn?.toISOString().slice(0, 10) ?? null,
    createdAt: item.createdAt.toISOString(),
    valueKg: item.value.toNumber(),
  }
}

export async function getWeightChartReadings(owner: OwnerContext, period: WeightChartPeriod) {
  ownerId(owner)
  const prisma = await getPrismaClient()
  const cutoff = weightCutoff(period)
  const measurements = await prisma.bodyMeasurement.findMany({
    where: ownedWhere(owner, {
      measurementType: 'WEIGHT',
      ...(cutoff ? { measuredAt: { gte: cutoff } } : {}),
    }),
    orderBy: weightOrder,
    select: weightSelect,
  })
  return measurements.map(serializeWeight)
}

export async function getWeightHistoryPage(owner: OwnerContext, page: number) {
  ownerId(owner)
  const prisma = await getPrismaClient()
  const where = ownedWhere(owner, { measurementType: 'WEIGHT' })
  const [total, measurements] = await Promise.all([
    prisma.bodyMeasurement.count({ where }),
    prisma.bodyMeasurement.findMany({
      where,
      orderBy: weightOrder,
      select: weightSelect,
      skip: (page - 1) * weightHistoryPageSize,
      take: weightHistoryPageSize,
    }),
  ])
  return {
    items: measurements.map(serializeWeight),
    page,
    pageSize: weightHistoryPageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / weightHistoryPageSize)),
  }
}

export class WeightRequestConflictError extends Error {
  constructor() {
    super('Weight request ID was already used for another reading')
  }
}

export class SexRequiredError extends Error {
  constructor() {
    super('Select male or female before saving the profile')
  }
}

export type ProfilePatch = z.infer<typeof profilePatchSchema>

export async function getMeasurementSystem(owner: OwnerContext): Promise<MeasurementSystem> {
  ownerId(owner)
  const prisma = await getPrismaClient()
  const profile = await prisma.athleteProfile.findUnique({
    where: ownedWhere(owner, {}),
    select: { measurementSystem: true },
  })
  return normalizeMeasurementSystem(profile?.measurementSystem)
}

function serializeAthleteProfile(profile: AthleteProfile | null) {
  const weekdays = z
    .array(z.number().int().min(0).max(6))
    .safeParse(profile?.defaultAvailableWeekdays)
  return {
    displayName: profile?.displayName ?? null,
    birthDate: profile?.birthDate?.toISOString().slice(0, 10) ?? null,
    sex: profile?.sex ?? null,
    heightCm: profile?.heightCm?.toNumber() ?? null,
    experienceLevel: experienceLevel.catch('BEGINNER').parse(profile?.experienceLevel),
    measurementSystem: normalizeMeasurementSystem(profile?.measurementSystem),
    defaultTrainingDaysPerWeek: profile?.defaultTrainingDaysPerWeek ?? null,
    defaultAvailableWeekdays: weekdays.success ? weekdays.data : null,
  }
}

export async function getAthleteProfile(owner: OwnerContext) {
  ownerId(owner)
  const prisma = await getPrismaClient()
  const profile = await prisma.athleteProfile.findUnique({ where: ownedWhere(owner, {}) })
  return serializeAthleteProfile(profile)
}

export async function getAthleteSettings(owner: OwnerContext, period: WeightChartPeriod = '7D') {
  ownerId(owner)
  const prisma = await getPrismaClient()
  const [profile, measurements, chartWeights] = await Promise.all([
    getAthleteProfile(owner),
    prisma.bodyMeasurement.findMany({
      where: ownedWhere(owner, { measurementType: 'WEIGHT' }),
      orderBy: weightOrder,
      select: weightSelect,
      take: 3,
    }),
    getWeightChartReadings(owner, period),
  ])
  return {
    profile,
    weights: measurements.map(serializeWeight),
    chartWeights,
  }
}

export async function updateAthleteProfile(owner: OwnerContext, patch: ProfilePatch) {
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  const onlyMeasurementSystem =
    patch.measurementSystem !== undefined && Object.keys(patch).length === 1
  if (patch.sex === undefined && !onlyMeasurementSystem) {
    const existing = await prisma.athleteProfile.findUnique({
      where: ownedWhere(owner, {}),
      select: { sex: true },
    })
    if (existing?.sex !== 'MALE' && existing?.sex !== 'FEMALE') throw new SexRequiredError()
  }
  const data: Prisma.AthleteProfileUncheckedCreateInput = {
    ...patch,
    birthDate: patch.birthDate ? new Date(`${patch.birthDate}T00:00:00.000Z`) : patch.birthDate,
    defaultAvailableWeekdays:
      patch.defaultAvailableWeekdays === null ? Prisma.DbNull : patch.defaultAvailableWeekdays,
    userId,
  }
  await prisma.athleteProfile.upsert({
    where: ownedWhere(owner, {}),
    create: data,
    update: data,
  })
}

export async function addWeight(owner: OwnerContext, input: z.infer<typeof weightInputSchema>) {
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  const kilograms = input.unit === 'LB' ? input.value * 0.45359237 : input.value
  const value = Math.round(kilograms * 100) / 100
  const measuredAt = input.measuredOn
    ? new Date(
        Date.parse(`${input.measuredOn}T12:00:00.000Z`) +
          (input.timezoneOffsetMinutes ?? 0) * 60_000,
      )
    : new Date()
  const measuredOn = input.measuredOn ? new Date(`${input.measuredOn}T00:00:00.000Z`) : null
  const select = {
    id: true,
    measuredAt: true,
    measuredOn: true,
    createdAt: true,
    value: true,
    unit: true,
    measurementType: true,
  } as const
  try {
    return await prisma.bodyMeasurement.create({
      data: {
        userId,
        measuredAt,
        measuredOn,
        measurementType: 'WEIGHT',
        value,
        unit: 'KG',
        source: 'MANUAL',
        sourceExternalId: input.requestId,
      },
      select,
    })
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
      throw error
    const existing = await prisma.bodyMeasurement.findUnique({
      where: {
        userId_source_sourceExternalId: {
          userId,
          source: 'MANUAL',
          sourceExternalId: input.requestId,
        },
      },
      select,
    })
    if (!existing) throw error
    const sameSelectedDate =
      input.measuredOn === undefined
        ? existing.measuredOn === null
        : existing.measuredOn
          ? existing.measuredOn.toISOString().slice(0, 10) === input.measuredOn
          : input.timezoneOffsetMinutes !== undefined
            ? existing.measuredAt.getTime() === measuredAt.getTime()
            : existing.measuredAt.toISOString().slice(0, 10) === input.measuredOn
    if (
      existing.measurementType !== 'WEIGHT' ||
      existing.unit !== 'KG' ||
      !existing.value.equals(value) ||
      !sameSelectedDate ||
      (existing.measuredOn &&
        input.timezoneOffsetMinutes !== undefined &&
        existing.measuredAt.getTime() !== measuredAt.getTime())
    )
      throw new WeightRequestConflictError()
    return existing
  }
}
