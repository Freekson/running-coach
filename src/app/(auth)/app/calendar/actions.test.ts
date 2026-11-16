import { beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'

vi.mock('server-only', () => ({}))
const { currentUser, move } = vi.hoisted(() => ({ currentUser: vi.fn(), move: vi.fn() }))
vi.mock('@/server/auth/current-user', () => ({
  getCurrentUser: currentUser,
  isVerifiedCurrentUser: () => true,
  AccountUnavailableError: class extends Error {},
}))
vi.mock('@/server/plans/calendar', () => ({
  rescheduleCalendarWorkout: move,
  CalendarEditError: class extends Error {},
}))
import { rescheduleWorkoutAction } from './actions'
import { CalendarEditError } from '@/server/plans/calendar'
import { PlanConflictError } from '@/server/plans/transaction'
import { OwnedResourceNotFoundError } from '@/server/authorization/ownership'

beforeEach(() => {
  vi.clearAllMocks()
  currentUser.mockResolvedValue({ id: 'owner', role: 'USER' })
  move.mockResolvedValue('revision')
})
it('rejects unauthenticated actions before reading or writing private data', async () => {
  currentUser.mockResolvedValue(null)
  expect(await rescheduleWorkoutAction({})).toMatchObject({ success: false, code: 'unauthorized' })
  expect(move).not.toHaveBeenCalled()
})
it('derives USER and ADMIN ownership from the current session for every action', async () => {
  const input = { workoutId: 'workout' }
  expect(await rescheduleWorkoutAction(input)).toEqual({ success: true })
  currentUser.mockResolvedValue({ id: 'different-admin', role: 'ADMIN' })
  await rescheduleWorkoutAction(input)
  expect(move.mock.calls.map(([owner]) => owner.userId)).toEqual(['owner', 'different-admin'])
})
it.each([
  [new PlanConflictError(), 'conflict'],
  [new OwnedResourceNotFoundError(), 'missing'],
  [new CalendarEditError('Locked session'), 'locked'],
  [new z.ZodError([]), 'invalid'],
  [new Error('private database details'), 'unavailable'],
])('returns safe actionable errors for %s', async (error, code) => {
  move.mockRejectedValue(error)
  const result = await rescheduleWorkoutAction({})
  expect(result).toMatchObject({ success: false, code })
  expect(JSON.stringify(result)).not.toContain('private database details')
})
