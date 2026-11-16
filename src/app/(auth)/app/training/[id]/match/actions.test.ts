import { beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'

vi.mock('server-only', () => ({}))
const { currentUser, link, unlink } = vi.hoisted(() => ({
  currentUser: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
}))
vi.mock('@/server/auth/current-user', () => ({
  getCurrentUser: currentUser,
  isVerifiedCurrentUser: () => true,
  AccountUnavailableError: class extends Error {},
}))
vi.mock('@/server/activity/matching', () => ({
  linkActivity: link,
  unlinkActivity: unlink,
  ActivityMatchError: class extends Error {},
}))
import { linkActivityAction, unlinkActivityAction } from './actions'
import { PlanConflictError } from '@/server/plans/transaction'
import { OwnedResourceNotFoundError } from '@/server/authorization/ownership'
import { ActivityMatchError } from '@/server/activity/matching'

beforeEach(() => {
  vi.clearAllMocks()
  currentUser.mockResolvedValue({ id: 'athlete', role: 'USER' })
  link.mockResolvedValue(undefined)
  unlink.mockResolvedValue(undefined)
})
it.each([linkActivityAction, unlinkActivityAction])(
  'rejects unauthenticated mutations before any private operation',
  async (action) => {
    currentUser.mockResolvedValue(null)
    expect(await action({})).toMatchObject({ success: false })
    expect(link).not.toHaveBeenCalled()
    expect(unlink).not.toHaveBeenCalled()
  },
)
it('uses the verified session owner for USER and ADMIN and never a submitted owner', async () => {
  const input = { userId: 'victim' }
  await linkActivityAction(input)
  currentUser.mockResolvedValue({ id: 'different-admin', role: 'ADMIN' })
  await unlinkActivityAction(input)
  expect(link.mock.calls[0][0].userId).toBe('athlete')
  expect(unlink.mock.calls[0][0].userId).toBe('different-admin')
})
it.each([
  new PlanConflictError(),
  new OwnedResourceNotFoundError(),
  new ActivityMatchError('Duplicate already linked'),
  new z.ZodError([]),
  new Error('private database details'),
])('returns a safe failure for %s', async (error) => {
  link.mockRejectedValue(error)
  const result = await linkActivityAction({})
  expect(result.success).toBe(false)
  expect(JSON.stringify(result)).not.toContain('private database details')
})
