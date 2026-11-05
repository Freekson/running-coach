import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getCurrentUser, redirect, requestPath } = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  requestPath: vi.fn(() => '/app/dashboard'),
  redirect: vi.fn((destination: string) => {
    throw new Error(`Redirect to ${destination}`)
  }),
}))

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-running-coach-app-path': requestPath() }),
}))
vi.mock('@/server/auth/current-user', () => ({
  AccountUnavailableError: class AccountUnavailableError extends Error {},
  getCurrentUser,
}))
vi.mock('@/server/auth/invitation-management', () => ({
  listInvitations: vi.fn(async () => []),
  listRegisteredUsers: vi.fn(async () => []),
}))
const { notFound } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error('Not found')
  }),
}))
vi.mock('next/navigation', () => ({ redirect, notFound }))
vi.mock('../sign-out-button', () => ({ SignOutButton: () => null }))

import AppLayout from './layout'
import AppPage from './page'
import DashboardPage from './dashboard/page'
import TrainingPage from './training/page'
import CalendarPage from './calendar/page'
import GoalsPage from './goals/page'
import SettingsPage from './settings/page'
import AdminPage from './admin/page'
import { AppShell } from './app-shell'
import { AccountUnavailable } from './account-unavailable'
import { AccountUnavailableError } from '@/server/auth/current-user'

beforeEach(() => {
  vi.clearAllMocks()
  requestPath.mockReturnValue('/app/dashboard')
})

describe('authenticated /app routes', () => {
  it('redirects signed-out and expired sessions before rendering nested pages', async () => {
    getCurrentUser.mockResolvedValue(null)
    const dashboard = <DashboardPage />
    await expect(AppLayout({ children: dashboard })).rejects.toThrow(
      'Redirect to /sign-in?next=%2Fapp%2Fdashboard',
    )
    expect(redirect).toHaveBeenCalledWith('/sign-in?next=%2Fapp%2Fdashboard')
  })

  it('preserves a signed-out deep link through sign-in', async () => {
    getCurrentUser.mockResolvedValue(null)
    requestPath.mockReturnValue('/app/calendar')
    await expect(AppLayout({ children: <CalendarPage /> })).rejects.toThrow(
      'Redirect to /sign-in?next=%2Fapp%2Fcalendar',
    )
    await expect(CalendarPage()).rejects.toThrow('Redirect to /sign-in?next=%2Fapp%2Fcalendar')
  })

  it('falls back to dashboard for an invalid destination header', async () => {
    getCurrentUser.mockResolvedValue(null)
    requestPath.mockReturnValue('//evil.example')
    await expect(AppLayout({ children: <DashboardPage /> })).rejects.toThrow(
      'Redirect to /sign-in?next=%2Fapp%2Fdashboard',
    )
  })

  it('allows a signed-in user through the shared layout and renders their shell in the page', async () => {
    getCurrentUser.mockResolvedValue({ id: 'user-a', role: 'USER' })
    const dashboard = <DashboardPage />
    await expect(AppLayout({ children: dashboard })).resolves.toBe(dashboard)
    await expect(DashboardPage()).resolves.toMatchObject({
      type: AppShell,
      props: { user: { id: 'user-a', role: 'USER' } },
    })
  })

  it('shows the account unavailable state for a suspended user', async () => {
    getCurrentUser.mockRejectedValue(new AccountUnavailableError())
    const result = await AppLayout({ children: <DashboardPage /> })
    expect(result).toMatchObject({ type: AccountUnavailable })
    expect((await DashboardPage()).type).toBe(AccountUnavailable)
    expect((await AppPage()).type).toBe(AccountUnavailable)
    expect(redirect).not.toHaveBeenCalled()
  })

  it('redirects direct page rendering without a session before returning private content', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(DashboardPage()).rejects.toThrow('Redirect to /sign-in?next=%2Fapp%2Fdashboard')
    await expect(AppPage()).rejects.toThrow('Redirect to /sign-in?next=%2Fapp%2Fdashboard')
    for (const page of [TrainingPage, CalendarPage, GoalsPage, SettingsPage, AdminPage]) {
      await expect(page()).rejects.toThrow('Redirect to /sign-in?next=%2Fapp%2Fdashboard')
    }
    expect(redirect).toHaveBeenCalledTimes(7)
  })

  it('provides honest content for each linked route', async () => {
    getCurrentUser.mockResolvedValue({ id: 'user-a', role: 'USER', email: 'a@example.test' })
    for (const page of [TrainingPage, CalendarPage, GoalsPage, SettingsPage]) {
      const result = await page()
      expect(result.type).toBe(AppShell)
      expect(result.props.children.props.description).toMatch(/later/)
    }
  })

  it('blocks a different non-admin user from the admin route', async () => {
    getCurrentUser.mockResolvedValue({ id: 'user-b', role: 'USER', email: 'b@example.test' })
    await expect(AdminPage()).rejects.toThrow('Not found')
    expect(notFound).toHaveBeenCalledOnce()
  })

  it('allows an admin to reach the admin management page', async () => {
    getCurrentUser.mockResolvedValue({ id: 'admin-a', role: 'ADMIN', email: 'admin@example.test' })
    const result = await AdminPage()
    expect(result.type).toBe(AppShell)
    expect(result.props.children.props.invitations).toEqual([])
    expect(result.props.children.props.users).toEqual([])
  })

  it('rechecks the session when rendering the dashboard again', async () => {
    getCurrentUser.mockResolvedValueOnce({ id: 'user-a', role: 'USER' }).mockResolvedValueOnce(null)
    expect((await DashboardPage()).type).toBe(AppShell)
    await expect(DashboardPage()).rejects.toThrow('Redirect to /sign-in?next=%2Fapp%2Fdashboard')
  })

  it('uses the current role and identity for each navigated page', async () => {
    getCurrentUser
      .mockResolvedValueOnce({ id: 'admin-a', role: 'ADMIN', email: 'admin@example.test' })
      .mockResolvedValueOnce({ id: 'user-b', role: 'USER', email: 'user@example.test' })

    const first = await DashboardPage()
    const second = await TrainingPage()
    expect(first.props.user).toMatchObject({ id: 'admin-a', role: 'ADMIN' })
    expect(second.props.user).toMatchObject({
      id: 'user-b',
      role: 'USER',
      email: 'user@example.test',
    })
  })

  it('removes the shell when an account becomes unavailable between pages', async () => {
    getCurrentUser
      .mockResolvedValueOnce({ id: 'admin-a', role: 'ADMIN', email: 'admin@example.test' })
      .mockRejectedValueOnce(new AccountUnavailableError())

    expect((await DashboardPage()).type).toBe(AppShell)
    expect((await TrainingPage()).type).toBe(AccountUnavailable)
  })

  it('redirects the signed-in /app index to /app/dashboard', async () => {
    getCurrentUser.mockResolvedValue({ id: 'user-a', role: 'USER' })
    await expect(AppPage()).rejects.toThrow('Redirect to /app/dashboard')
    expect(redirect).toHaveBeenCalledWith('/app/dashboard')
  })
})
