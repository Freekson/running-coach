import { expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import {
  projectCommitment,
  assertRefreshGoalHorizon,
  projectMacroPlan,
  selectRefreshCommitments,
  type StoredCommitment,
} from './refresh-context'
import { fixtureId, fixtureNow } from './fixtures'

const privateText = 'PRIVATE prior injury, sleep and athlete background'
function row(index: number, date: string, cancelled = false): StoredCommitment {
  return {
    workoutId: fixtureId(index),
    scheduledDate: new Date(date),
    timezone: 'Asia/Tokyo',
    cancelled,
    definition: {
      schemaVersion: 1,
      name: privateText,
      sport: 'RUNNING',
      steps: [
        {
          type: 'repeat',
          count: 2,
          steps: [
            {
              type: 'step',
              name: privateText,
              termination: { type: 'time', durationSeconds: 120 },
              target: { type: 'free' },
            },
          ],
        },
      ],
    },
    workout: {
      completedAt: null,
      lockedAt: null,
      completedActivityId: fixtureId(999),
      completionAt: null,
      completionFromActivity: false,
    },
  }
}
const window = { startDate: '2026-11-16', endDate: '2026-12-13' }

it('rejects an incompatible goal date without changing the approved macro strategy', () => {
  const macro = {
    startDate: '2026-11-01',
    endDate: '2026-12-31',
    strategy: privateText,
    phases: [{ startDate: '2026-11-01', endDate: '2026-12-31', label: 'Base', notes: '' }],
  }
  const original = structuredClone(macro)
  expect(() => assertRefreshGoalHorizon(macro, '2027-01-07')).toThrow('Create a new training plan')
  expect(() => assertRefreshGoalHorizon(macro, '2026-12-31')).not.toThrow()
  expect(() => assertRefreshGoalHorizon(macro, null)).not.toThrow()
  expect(macro).toEqual(original)
})

it('projects macro and recursively nested workout text without mutating approved source records', () => {
  const macro = {
    startDate: '2026-11-01',
    endDate: '2026-12-31',
    strategy: privateText,
    phases: [
      { startDate: '2026-11-01', endDate: '2026-12-31', label: privateText, notes: privateText },
    ],
  }
  const original = row(1, '2026-11-17')
  const before = JSON.stringify({ macro, original })
  const projected = projectCommitment(original, false)
  expect(JSON.stringify({ macro: projectMacroPlan(macro), workout: projected })).not.toContain(
    privateText,
  )
  expect(projected.definition.steps).toEqual([
    {
      type: 'repeat',
      count: 2,
      steps: [
        {
          type: 'step',
          termination: { type: 'time', durationSeconds: 120 },
          target: { type: 'free' },
        },
      ],
    },
  ])
  expect(projected.activityId).toBeNull()
  expect(projectCommitment(original, true).activityId).toBe(fixtureId(999))
  expect(JSON.stringify({ macro, original })).toBe(before)
})

it('bounds past history while retaining current-week capacity, window locks and all active future commitments', () => {
  const old = Array.from({ length: 240 }, (_, i) => row(i + 1, '2026-01-01', i % 2 === 0))
  const currentWeek = row(300, '2026-11-10')
  currentWeek.workout.completedAt = new Date('2026-11-10T00:00:00Z')
  const locked = row(301, '2026-11-17')
  locked.workout.lockedAt = fixtureNow
  const outsideWindow = row(302, '2027-01-01')
  const cancelledInWindow = row(303, '2026-11-18', true)
  const lockedCancellation = row(304, '2026-11-19', true)
  lockedCancellation.workout.lockedAt = fixtureNow
  const result = selectRefreshCommitments(
    [...old, currentWeek, locked, outsideWindow, cancelledInWindow, lockedCancellation],
    window,
    'Asia/Tokyo',
    fixtureNow,
  )
  expect(result.required.map((r) => r.workoutId)).toEqual(
    [currentWeek, locked, outsideWindow, lockedCancellation].map((r) => r.workoutId),
  )
  expect(result.history).toHaveLength(20)
  expect(
    selectRefreshCommitments(
      [...old].reverse().concat([cancelledInWindow]),
      window,
      'Asia/Tokyo',
      fixtureNow,
    ).history,
  ).toEqual(result.history)
})

it('bounds hundreds of unprotected cancellation tombstones inside the same detail window', () => {
  const cancelled = Array.from({ length: 240 }, (_, i) => row(i + 1, '2026-11-17', true))
  const active = row(300, '2026-11-17')
  const before = JSON.stringify(cancelled)
  const result = selectRefreshCommitments([...cancelled, active], window, 'Asia/Tokyo', fixtureNow)
  expect(result.required).toEqual([active])
  expect(result.history).toHaveLength(20)
  expect(result.history.every((r) => r.cancelled)).toBe(true)
  expect(JSON.stringify(cancelled)).toBe(before)
})

it('fails only when required validation context itself exceeds the contract commitment limit', () => {
  expect(() =>
    selectRefreshCommitments(
      Array.from({ length: 201 }, (_, i) => row(i + 1, '2026-11-17')),
      window,
      'Asia/Tokyo',
      fixtureNow,
    ),
  ).toThrow()
})
it('exports a retracted match as unknown while preserving its history lock', () => {
  const corrected = row(401, '2026-11-17')
  corrected.workout = {
    completedAt: fixtureNow,
    lockedAt: fixtureNow,
    completedActivityId: null,
    completionAt: null,
    completionFromActivity: true,
  }
  expect(projectCommitment(corrected, true)).toMatchObject({
    outcome: 'unknown',
    completedAt: null,
    lockedAt: fixtureNow.toISOString(),
    activityId: null,
  })
})
