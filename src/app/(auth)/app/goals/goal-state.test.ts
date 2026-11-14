import { expect, it } from 'vitest'
import type { GoalWithProgress } from '@/lib/goal-progress'
import type { GoalMutation, GoalSnapshot } from '@/lib/goal-snapshot'
import {
  acceptGoalMutation,
  acceptGoalSnapshot,
  createGoalState,
  goalStateRecords,
  seesGoalMutation,
} from './goal-state'

const ownerId = 'synthetic-owner'
const goal: GoalWithProgress = {
  id: 'existing',
  name: 'Synthetic goal',
  type: 'COMPLETION',
  distanceMeters: 5000,
  targetTimeSeconds: null,
  targetCount: null,
  measurementWindow: null,
  targetDate: null,
  surface: 'ANY',
  elevationGainM: null,
  archived: false,
  progress: {
    status: 'ACTIVE',
    timezone: 'UTC',
    from: null,
    through: '2026-11-14',
    daysRemaining: null,
    distanceMeters: 0,
    elevationGainM: 0,
    runCount: 0,
    surfaceUnknownRunCount: 0,
    bestTimeSeconds: null,
    percent: null,
    achieved: false,
    planCoverage: 'UNAVAILABLE',
  },
}
const created = { ...goal, id: 'created' }
function snapshot(goals = [goal], version = '100:100:', observedAt = '1'): GoalSnapshot {
  return { ownerId, goals, snapshot: version, observedAt }
}
function mutation(
  value: GoalWithProgress | null,
  transactionId = '101',
  seen = '101:101:',
): GoalMutation<GoalWithProgress | null> {
  return { value, receipt: { ownerId, transactionId, snapshot: seen } }
}

it.each([
  ['100:103:100,101', '99', true],
  ['100:103:100,101', '100', false],
  ['100:103:100,101', '101', false],
  ['100:103:100,101', '102', true],
  ['100:103:100,101', '103', false],
  ['100:103:100,101', '104', false],
  ['9007199254740992:9007199254740995:9007199254740993', '9007199254740993', false],
  ['9007199254740992:9007199254740995:9007199254740993', '9007199254740994', true],
] as const)('checks transaction visibility for %s / %s', (version, transactionId, visible) => {
  expect(seesGoalMutation(version, transactionId)).toBe(visible)
})

it('retains a confirmed creation when a delayed read sees another commit but not the creation', () => {
  let state = acceptGoalMutation(createGoalState(snapshot()), created.id, mutation(created))
  state = acceptGoalSnapshot(
    state,
    snapshot([{ ...goal, name: 'Changed by another commit' }], '101:103:101', '2'),
  )
  expect(goalStateRecords(state).map((item) => item.id)).toEqual(['created', 'existing'])
  expect(goalStateRecords(state)[1].name).toBe('Changed by another commit')
  expect(state.confirmed.size).toBe(1)
})

it('keeps fresher progress when the list already sees a pending mutation response', () => {
  const achieved: GoalWithProgress = {
    ...created,
    progress: { ...created.progress, status: 'ACHIEVED', achieved: true },
  }
  let state = acceptGoalSnapshot(
    createGoalState(snapshot()),
    snapshot([achieved, goal], '103:103:', '2'),
  )
  state = acceptGoalMutation(state, created.id, mutation(created))
  expect(goalStateRecords(state)[0].progress.status).toBe('ACHIEVED')
  expect(state.confirmed.size).toBe(0)
})

it('acknowledges confirmed writes and accepts later remote changes or deletion', () => {
  const initial = acceptGoalMutation(createGoalState(snapshot()), created.id, mutation(created))
  const updated = acceptGoalSnapshot(
    initial,
    snapshot([{ ...created, name: 'Later edit' }, goal], '104:104:', '2'),
  )
  expect(goalStateRecords(updated)[0].name).toBe('Later edit')
  expect(updated.confirmed.size).toBe(0)
  const deleted = acceptGoalSnapshot(initial, snapshot([goal], '104:104:', '2'))
  expect(goalStateRecords(deleted).map((item) => item.id)).toEqual(['existing'])
  expect(deleted.confirmed.size).toBe(0)
})

it('keeps confirmed deletion across delayed snapshots and cannot resurrect it after acknowledgement', () => {
  let state = acceptGoalMutation(createGoalState(snapshot()), goal.id, mutation(null))
  state = acceptGoalSnapshot(state, snapshot([goal], '101:103:101', '2'))
  expect(goalStateRecords(state)).toEqual([])
  state = acceptGoalSnapshot(state, snapshot([], '103:103:', '3'))
  expect(state.confirmed.size).toBe(0)
  state = acceptGoalSnapshot(state, snapshot([goal], '101:103:101', '4'))
  expect(goalStateRecords(state)).toEqual([])
})

it('orders reads with identical visibility by the database clock and ignores older snapshots', () => {
  let state = createGoalState(snapshot([goal], '103:103:', '20'))
  state = acceptGoalSnapshot(state, snapshot([{ ...goal, name: 'Older' }], '102:102:', '100'))
  expect(goalStateRecords(state)[0].name).toBe(goal.name)
  state = acceptGoalSnapshot(
    state,
    snapshot([{ ...goal, name: 'Earlier clock' }], '103:103:', '19'),
  )
  expect(goalStateRecords(state)[0].name).toBe(goal.name)
  state = acceptGoalSnapshot(state, snapshot([{ ...goal, name: 'Later clock' }], '103:103:', '21'))
  expect(goalStateRecords(state)[0].name).toBe('Later clock')
})

it('keeps a later restore when an older archive response arrives afterwards', () => {
  const restored = mutation(goal, '102', '102:102:')
  let state = acceptGoalMutation(createGoalState(snapshot()), goal.id, restored)
  state = acceptGoalMutation(state, goal.id, mutation({ ...goal, archived: true }))
  expect(goalStateRecords(state)[0].archived).toBe(false)
  expect(state.confirmed.get(goal.id)?.receipt.transactionId).toBe('102')
})

it('replaces archive with a causally later restore and handles repeated delivery idempotently', () => {
  let state = acceptGoalMutation(
    createGoalState(snapshot()),
    goal.id,
    mutation({ ...goal, archived: true }),
  )
  const restored = mutation(goal, '102', '102:102:')
  state = acceptGoalMutation(state, goal.id, restored)
  expect(goalStateRecords(state)[0].archived).toBe(false)
  expect(acceptGoalMutation(state, goal.id, restored)).toBe(state)
})

it('clears local state on owner changes and rejects late responses from the previous owner', () => {
  let state = acceptGoalMutation(createGoalState(snapshot()), created.id, mutation(created))
  state = acceptGoalSnapshot(state, { ...snapshot([], '100:100:'), ownerId: 'other-owner' })
  state = acceptGoalMutation(state, created.id, mutation(created))
  expect(goalStateRecords(state)).toEqual([])
  expect(state.confirmed.size).toBe(0)
})
