import { describe, expect, it } from 'vitest'
import { goalInputSchema, type GoalInput } from './goals'
import { planConstraintDefaults, planConstraintsSchema } from './plan-constraints'

const base: GoalInput = {
  name: 'A running goal',
  type: 'PERFORMANCE',
  distanceMeters: 3000,
  targetTimeSeconds: null,
  targetCount: null,
  measurementWindow: null,
  targetDate: null,
  surface: 'ANY',
  elevationGainM: null,
}

describe('canonical goals', () => {
  it.each([3000, 42195, 83501.125, 161000, 246800])(
    'supports arbitrary distance %s without a time',
    (distanceMeters) => {
      expect(goalInputSchema.parse({ ...base, distanceMeters }).targetTimeSeconds).toBeNull()
    },
  )
  it('validates volume and consistency measurement windows', () => {
    expect(goalInputSchema.safeParse({ ...base, type: 'VOLUME' }).success).toBe(false)
    expect(
      goalInputSchema.safeParse({ ...base, type: 'VOLUME', measurementWindow: 'MONTH' }).success,
    ).toBe(true)
    expect(
      goalInputSchema.safeParse({
        ...base,
        type: 'CONSISTENCY',
        distanceMeters: null,
        targetCount: 4,
        measurementWindow: 'WEEK',
      }).success,
    ).toBe(true)
    expect(
      goalInputSchema.safeParse({ ...base, type: 'CONSISTENCY', targetCount: 4 }).success,
    ).toBe(false)
  })
  it.each([
    { distanceMeters: 0 },
    { distanceMeters: -5 },
    { distanceMeters: Infinity },
    { targetDate: '2027-02-30' },
    { targetTimeSeconds: 0 },
    { elevationGainM: -1 },
    { userId: 'another-owner' },
    { sessionsPerWeek: 4 },
    { name: '  ' },
    { type: 'UNKNOWN' },
    { type: 'COMPLETION', targetTimeSeconds: 600 },
  ])('rejects malformed, inapplicable or forged fields %o', (patch) => {
    expect(goalInputSchema.safeParse({ ...base, ...patch }).success).toBe(false)
  })
})

describe('plan constraints', () => {
  it('copies defaults independently and never mutates the profile', () => {
    const profile = {
      defaultTrainingDaysPerWeek: 4,
      defaultAvailableWeekdays: [0, 1, 3, 5],
      preferredTimezone: 'Asia/Tokyo',
    }
    const a = planConstraintDefaults(profile)
    const b = planConstraintDefaults(profile)
    a.availableWeekdays.pop()
    expect(profile.defaultAvailableWeekdays).toEqual([0, 1, 3, 5])
    expect(b.availableWeekdays).toEqual([0, 1, 3, 5])
    expect(
      planConstraintsSchema.parse({
        ...b,
        sessionsPerWeek: 2,
        availableWeekdays: [2, 4],
        maxSessionMinutes: 60,
      }).sessionsPerWeek,
    ).toBe(2)
    expect(profile.defaultTrainingDaysPerWeek).toBe(4)
  })
  it.each([
    { availableWeekdays: [1, 1, 2] },
    { availableWeekdays: [0, 7, 2] },
    { availableWeekdays: [1] },
    { maxSessionMinutes: 0 },
    { sessionsPerWeek: 8 },
    { timezone: 'Mars/Orbit' },
    { startDate: '2027-02-30' },
    { userId: 'forged' },
  ])('rejects invalid schedules %o', (patch) => {
    expect(
      planConstraintsSchema.safeParse({ ...planConstraintDefaults(null), ...patch }).success,
    ).toBe(false)
  })
  it('offers valid defaults for missing or inconsistent legacy profiles', () => {
    expect(planConstraintsSchema.safeParse(planConstraintDefaults(null)).success).toBe(true)
    expect(
      planConstraintDefaults({
        defaultTrainingDaysPerWeek: 5,
        defaultAvailableWeekdays: [1, 2],
        preferredTimezone: null,
      }).availableWeekdays,
    ).toHaveLength(7)
  })
})
