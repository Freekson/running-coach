import { beforeEach, expect, it, vi } from 'vitest'

const { getAppUser, listGoals, getGoal, getOwnerContext } = vi.hoisted(() => ({
  getAppUser: vi.fn(),
  listGoals: vi.fn(),
  getGoal: vi.fn(),
  getOwnerContext: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('../access', () => ({ getAppUser }))
vi.mock('@/server/goals/goals', async (original) => ({
  ...(await original<typeof import('@/server/goals/goals')>()),
  getEditableGoal: getGoal,
  getGoalsSnapshot: listGoals,
}))
vi.mock('@/server/authorization/ownership', async (original) => ({
  ...(await original<typeof import('@/server/authorization/ownership')>()),
  getOwnerContext,
}))
vi.mock('next/navigation', () => ({
  redirect: () => {
    throw new Error('redirect-to-goals')
  },
  notFound: () => {
    throw new Error('not-found')
  },
}))
import { OwnedResourceNotFoundError } from '@/server/authorization/ownership'
import { renderGoalsPage } from './goals-page'
import { AccountUnavailable } from '../account-unavailable'
import { GoalReadOnlyError } from '@/server/goals/goals'

beforeEach(() => {
  vi.clearAllMocks()
  getAppUser.mockResolvedValue({ id: 'a' })
  getOwnerContext.mockReturnValue({ userId: 'a' })
  listGoals.mockResolvedValue({ ownerId: 'a', snapshot: '100:100:', observedAt: '1', goals: [] })
  getGoal.mockResolvedValue(undefined)
})

it('checks account access before loading any private data for every goals route', async () => {
  getAppUser.mockResolvedValue(null)
  for (const editor of [
    undefined,
    'create' as const,
    { id: '9dd75c80-6ea2-4ce7-b715-a79b2d4d8836' },
  ]) {
    expect((await renderGoalsPage(editor)).type).toBe(AccountUnavailable)
  }
  expect(listGoals).not.toHaveBeenCalled()
  expect(getGoal).not.toHaveBeenCalled()
})

it('loads owner-scoped list and editor data and turns other-owner resources into 404', async () => {
  const id = '9dd75c80-6ea2-4ce7-b715-a79b2d4d8836'
  getGoal.mockRejectedValueOnce(new OwnedResourceNotFoundError())
  await expect(renderGoalsPage({ id })).rejects.toThrow('not-found')
  expect(listGoals).toHaveBeenCalledWith({ userId: 'a' })
  expect(getGoal).toHaveBeenCalledWith({ userId: 'a' }, id)
})

it('rejects malformed IDs before querying and shows a safe read error', async () => {
  await expect(renderGoalsPage({ id: 'invalid' })).rejects.toThrow('not-found')
  expect(listGoals).not.toHaveBeenCalled()
  listGoals.mockRejectedValueOnce(new Error('private SQL text'))
  const result = await renderGoalsPage()
  expect(JSON.stringify(result)).toContain('Goals unavailable')
  expect(JSON.stringify(result)).not.toContain('private SQL text')
})

it('does not expose a direct edit dialog for a read-only goal', async () => {
  getGoal.mockRejectedValueOnce(new GoalReadOnlyError())
  await expect(renderGoalsPage({ id: '9dd75c80-6ea2-4ce7-b715-a79b2d4d8836' })).rejects.toThrow(
    'redirect-to-goals',
  )
})
