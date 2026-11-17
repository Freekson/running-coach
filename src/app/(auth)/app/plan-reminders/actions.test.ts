import { beforeEach, expect, it, vi } from 'vitest'
import { ownerId, OwnedResourceNotFoundError } from '@/server/authorization/ownership'
import { AccountUnavailableError } from '@/server/auth/current-user'
import { PlanConflictError } from '@/server/plans/transaction'
import { respondToPlanReminderAction } from './actions'

vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({ user: vi.fn(), respond: vi.fn(), revalidate: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }))
vi.mock('@/server/auth/current-user', () => ({
  getCurrentUser: mocks.user,
  isVerifiedCurrentUser: () => true,
  AccountUnavailableError: class extends Error {},
}))
vi.mock('@/server/plans/reminders', () => ({ respondToPlanReminder: mocks.respond }))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.user.mockResolvedValue({ id: 'verified-user', role: 'USER', email: null })
  mocks.respond.mockResolvedValue(undefined)
})

it('requires authentication and an available account before invoking the service', async () => {
  mocks.user.mockResolvedValue(null)
  expect(await respondToPlanReminderAction({})).toEqual({
    success: false,
    error: 'Sign in to manage plan reminders.',
  })
  mocks.user.mockRejectedValue(new AccountUnavailableError())
  expect(await respondToPlanReminderAction({})).toMatchObject({ success: false })
  expect(mocks.respond).not.toHaveBeenCalled()
  expect(mocks.revalidate).not.toHaveBeenCalled()
})

it('derives ownership from the verified session and invalidates reminders across app routes', async () => {
  const input = { planId: 'plan', fingerprint: 'event', action: 'dismiss' }
  expect(await respondToPlanReminderAction(input)).toEqual({ success: true })
  expect(ownerId(mocks.respond.mock.calls[0][0])).toBe('verified-user')
  expect(mocks.respond.mock.calls[0][1]).toBe(input)
  expect(mocks.revalidate).toHaveBeenCalledWith('/app', 'layout')
})

it.each([new OwnedResourceNotFoundError(), new PlanConflictError()])(
  'returns recovery guidance for denied or stale events',
  async (error) => {
    mocks.respond.mockRejectedValue(error)
    expect(await respondToPlanReminderAction({})).toEqual({
      success: false,
      error: 'This reminder changed. Reload to see your current plans.',
    })
    expect(mocks.revalidate).not.toHaveBeenCalled()
  },
)

it('does not leak private infrastructure errors', async () => {
  mocks.respond.mockRejectedValue(new Error('PRIVATE database details'))
  const result = await respondToPlanReminderAction({})
  expect(result.success).toBe(false)
  expect(JSON.stringify(result)).not.toContain('PRIVATE')
})
