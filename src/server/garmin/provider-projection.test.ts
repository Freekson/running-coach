import { expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { mergeGarminProjection, projectGarminHealth } from './provider-projection'

it('keeps only bounded named metric fields from an untrusted daily summary', () => {
  expect(
    projectGarminHealth('summary', {
      uuid: 'do-not-store',
      userProfilePk: 123,
      movement: { steps: { value: 12_000, goal: -1, distanceInMeters: 8_000 } },
      calories: { burnedActive: 550 },
      stress: { avgLevel: 45, maxLevel: 'bad' },
      bodyBattery: { latestValue: 61, activityEvents: [{ eventStartTimeGmt: 'private' }] },
      hydration: { consumedInMl: 500_000 },
    }),
  ).toEqual({
    schemaVersion: 1,
    steps: 12_000,
    distanceInMeters: 8_000,
    caloriesBurnedActive: 550,
    stressAvgLevel: 45,
    bodyBatteryLatestValue: 61,
  })
})

it('preserves valid earlier values when a later projection omits or malforms them', () => {
  const incoming = projectGarminHealth('sleep', { napTimeSeconds: 1200, avgHeartRate: 'bad' })
  expect(incoming).not.toBeNull()
  expect(
    mergeGarminProjection({ schemaVersion: 1, avgHeartRate: 54, privateId: 123 }, incoming!),
  ).toEqual({ schemaVersion: 1, avgHeartRate: 54, napTimeSeconds: 1200 })
  expect(projectGarminHealth('sleep', { napTimeSeconds: -1, uuid: 'private' })).toBeNull()
})
