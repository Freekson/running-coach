import { beforeEach, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ownerId } from '@/server/authorization/ownership'
import { PlanReminderRegion } from './plan-reminder-region'
import { PlanReminderBanner } from './plan-reminder-banner'

vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
const mocks = vi.hoisted(() => ({ reminders: vi.fn() }))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
vi.mock('@/server/plans/reminders', () => ({ getPlanReminders: mocks.reminders }))
vi.mock('./actions', () => ({ respondToPlanReminderAction: vi.fn() }))
const user = { id: 'verified-user', role: 'USER' as const, email: null }
beforeEach(() => vi.clearAllMocks())

it('reads persisted reminders for the verified page owner and renders keyed banners', async () => {
  mocks.reminders.mockResolvedValue([{ planId: 'plan', fingerprint: 'event' }])
  const result = await PlanReminderRegion({ user })
  expect(ownerId(mocks.reminders.mock.calls[0][0])).toBe(user.id)
  expect(result).toMatchObject([{ type: PlanReminderBanner, key: 'event' }])
})
it('renders nothing for a quiet state', async () => {
  mocks.reminders.mockResolvedValue([])
  expect(await PlanReminderRegion({ user })).toEqual([])
})
it('reports evaluation unavailability without leaking errors or claiming the plan is up to date', async () => {
  mocks.reminders.mockRejectedValue(new Error('PRIVATE DB detail'))
  const result = renderToStaticMarkup(await PlanReminderRegion({ user }))
  expect(result).toContain('temporarily unavailable')
  expect(result).toContain('/app/training/plan/refresh')
  expect(result).not.toContain('PRIVATE')
})
