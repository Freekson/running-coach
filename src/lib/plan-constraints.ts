import { z } from 'zod'
import { localDateSchema } from './goals'

export const availableWeekdaysSchema = z
  .array(z.number().int().min(0).max(6))
  .min(1)
  .max(7)
  .refine((days) => new Set(days).size === days.length, 'Choose each weekday once')
export const timezoneSchema = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value })
      return true
    } catch {
      return false
    }
  }, 'Choose a valid timezone')

export const planConstraintsSchema = z
  .strictObject({
    sessionsPerWeek: z.number().int().min(1).max(7),
    availableWeekdays: availableWeekdaysSchema,
    maxSessionMinutes: z.number().int().min(5).max(1440).nullable(),
    startDate: localDateSchema.nullable(),
    timezone: timezoneSchema,
  })
  .refine((constraints) => constraints.sessionsPerWeek <= constraints.availableWeekdays.length, {
    path: ['availableWeekdays'],
    message: 'Choose at least as many weekdays as sessions per week',
  })

export type PlanConstraints = z.infer<typeof planConstraintsSchema>

export function planConstraintDefaults(
  profile: {
    defaultTrainingDaysPerWeek: number | null
    defaultAvailableWeekdays: unknown
    preferredTimezone: string | null
  } | null,
): PlanConstraints {
  const days = availableWeekdaysSchema.safeParse(profile?.defaultAvailableWeekdays)
  const sessions = z.number().int().min(1).max(7).safeParse(profile?.defaultTrainingDaysPerWeek)
  const sessionsPerWeek = sessions.success
    ? sessions.data
    : Math.min(3, days.success ? days.data.length : 7)
  const availableWeekdays =
    days.success && days.data.length >= sessionsPerWeek ? [...days.data] : [0, 1, 2, 3, 4, 5, 6]
  return planConstraintsSchema.parse({
    sessionsPerWeek,
    availableWeekdays,
    maxSessionMinutes: null,
    startDate: null,
    timezone: timezoneSchema.safeParse(profile?.preferredTimezone).success
      ? profile?.preferredTimezone
      : 'UTC',
  })
}
