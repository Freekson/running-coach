import { beforeEach, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
vi.mock('server-only', () => ({}))
const { currentUser, read, measurement } = vi.hoisted(() => ({
  currentUser: vi.fn(),
  read: vi.fn(),
  measurement: vi.fn(),
}))
vi.mock('@/server/auth/current-user', () => ({
  getCurrentUser: currentUser,
  isVerifiedCurrentUser: () => true,
  AccountUnavailableError: class extends Error {},
}))
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-running-coach-app-path': '/app/calendar' }),
}))
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`Redirect ${path}`)
  },
}))
vi.mock('@/server/plans/calendar', () => ({ getTrainingCalendar: read }))
vi.mock('@/server/athlete/profile', () => ({ getMeasurementSystem: measurement }))
import Page from './page'
import Loading from './loading'
import { calendarFixture } from './calendar.fixtures'
import { AppShell } from '../app-shell'
import { AccountUnavailable } from '../account-unavailable'
import { AccountUnavailableError } from '@/server/auth/current-user'

beforeEach(() => {
  vi.clearAllMocks()
  currentUser.mockResolvedValue({ id: 'owner', role: 'USER' })
  read.mockResolvedValue(calendarFixture())
  measurement.mockResolvedValue('METRIC')
})
it('loads only the authenticated owner inside the existing app shell', async () => {
  expect((await Page()).type).toBe(AppShell)
  expect(read).toHaveBeenCalledWith({ userId: 'owner' }, { view: 'week' })
  currentUser.mockResolvedValue({ id: 'different-admin', role: 'ADMIN' })
  await Page({ searchParams: Promise.resolve({ date: '2026-11-01', view: 'month' }) })
  expect(read).toHaveBeenLastCalledWith(
    { userId: 'different-admin' },
    { date: '2026-11-01', view: 'month' },
  )
})
it('redirects an unauthenticated calendar and does not query private data', async () => {
  currentUser.mockResolvedValue(null)
  await expect(Page()).rejects.toThrow('Redirect /sign-in?next=%2Fapp%2Fcalendar')
  expect(read).not.toHaveBeenCalled()
})
it('removes the shell for an unavailable account', async () => {
  currentUser.mockRejectedValue(new AccountUnavailableError())
  expect((await Page()).type).toBe(AccountUnavailable)
  expect(read).not.toHaveBeenCalled()
})
it('rejects invalid query dates before querying and hides database errors', async () => {
  const invalid = await Page({ searchParams: Promise.resolve({ date: '2026-02-30' }) })
  expect(renderToStaticMarkup(invalid.props.children)).toContain('calendar date or view is invalid')
  expect(read).not.toHaveBeenCalled()
  read.mockRejectedValue(new Error('private SQL details'))
  const failed = await Page()
  const markup = renderToStaticMarkup(failed.props.children)
  expect(markup).toContain('calendar could not be loaded')
  expect(markup).not.toContain('private SQL details')
})
it('keeps authenticated shell and labels loading without reading the calendar', async () => {
  const page = await Loading()
  expect(page.type).toBe(AppShell)
  expect(renderToStaticMarkup(page.props.children)).toContain('Loading your training calendar')
  expect(read).not.toHaveBeenCalled()
})
