import { expect, it } from 'vitest'
import { goalInput, goalView } from './goal-view'

it('round trips arbitrary distances, multi-hour times and optional fields through the form', () => {
  const goal = {
    id: 'synthetic',
    archived: false,
    name: 'Trail result',
    type: 'PERFORMANCE' as const,
    distanceMeters: 83501.125,
    targetTimeSeconds: 125999,
    targetCount: null,
    measurementWindow: null,
    targetDate: '2027-05-10',
    surface: 'TRAIL' as const,
    elevationGainM: 3200,
  }
  expect({ ...goalInput(goalView(goal)), id: goal.id, archived: goal.archived }).toEqual(goal)
})

it('clears inapplicable fields after switching goal type', () => {
  const fields = {
    name: 'Finish an ultra',
    type: 'COMPLETION' as const,
    distanceKm: '161',
    targetTime: '00:10:00',
    targetDate: '',
    surface: 'TRAIL' as const,
    elevationGainM: '',
    sessionsPerWeek: '4',
    measurementWindow: 'WEEK' as const,
  }
  expect(goalInput(fields)).toMatchObject({
    distanceMeters: 161000,
    targetTimeSeconds: null,
    targetCount: null,
    measurementWindow: null,
    targetDate: null,
  })
})
