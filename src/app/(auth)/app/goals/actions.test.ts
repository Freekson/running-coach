import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  save: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
  revalidate: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({
  getCurrentUser: mocks.user,
  isVerifiedCurrentUser: () => true,
  AccountUnavailableError: class AccountUnavailableError extends Error {},
}))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }))
vi.mock('@/server/goals/goals', async (original) => ({
  ...(await original<typeof import('@/server/goals/goals')>()),
  saveGoalWithReceipt: mocks.save,
  archiveGoalWithReceipt: mocks.archive,
  deleteGoalWithReceipt: mocks.remove,
}))
import { GoalReadOnlyError } from '@/server/goals/goals'
import { saveGoalAction, archiveGoalAction, deleteGoalAction } from './actions'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.user.mockResolvedValue({
    id: '00000000-0000-4000-8000-000000000001',
    role: 'USER',
    email: null,
  })
})

it('returns only mutation results without invalidating or rerendering the current route', async () => {
  const saved = { id: 'synthetic', name: 'Synthetic goal' }
  const receipt = { ownerId: 'synthetic-owner', transactionId: '101', snapshot: '101:101:' }
  mocks.save.mockResolvedValue({ value: saved, receipt })
  mocks.archive.mockResolvedValue({ value: saved, receipt })
  mocks.remove.mockResolvedValue({ value: null, receipt })
  expect(await saveGoalAction({})).toEqual({ success: true, value: saved, receipt })
  expect(await archiveGoalAction('synthetic', true)).toEqual({
    success: true,
    value: saved,
    receipt,
  })
  expect(await deleteGoalAction('synthetic')).toEqual({ success: true, value: null, receipt })
  expect(mocks.revalidate).not.toHaveBeenCalled()
})

it('authenticates every mutation before touching data', async () => {
  mocks.user.mockResolvedValue(null)
  for (const result of [
    await saveGoalAction({}),
    await archiveGoalAction('synthetic', true),
    await deleteGoalAction('synthetic'),
  ])
    expect(result.success).toBe(false)
  expect(mocks.save).not.toHaveBeenCalled()
  expect(mocks.archive).not.toHaveBeenCalled()
  expect(mocks.remove).not.toHaveBeenCalled()
})

it('exposes only the safe read-only error for a goal that became achieved while its editor was open', async () => {
  mocks.save.mockRejectedValue(new GoalReadOnlyError())
  expect(await saveGoalAction({}, 'synthetic')).toEqual({
    success: false,
    error: new GoalReadOnlyError().message,
  })
})
