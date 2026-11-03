import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getCurrentUser, redirect } = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  redirect: vi.fn((destination: string) => {
    throw new Error(`Redirect to ${destination}`)
  }),
}))

vi.mock('@/server/auth/current-user', () => ({
  AccountUnavailableError: class AccountUnavailableError extends Error {},
  getCurrentUser,
}))
vi.mock('next/navigation', () => ({ redirect }))
vi.mock('../sign-out-button', () => ({ SignOutButton: () => null }))

import AppLayout from './layout'
import AppPage from './page'
import DashboardPage from './dashboard/page'
import { AccountUnavailable } from './account-unavailable'
import { AccountUnavailableError } from '@/server/auth/current-user'

beforeEach(() => vi.clearAllMocks())

describe('authenticated /app routes', () => {
  it('redirects signed-out and expired sessions before rendering nested pages', async () => {
    getCurrentUser.mockResolvedValue(null)
    const dashboard = <DashboardPage />
    await expect(AppLayout({ children: dashboard })).rejects.toThrow(
      'Redirect to /sign-in?next=%2Fapp%2Fdashboard',
    )
    expect(redirect).toHaveBeenCalledWith('/sign-in?next=%2Fapp%2Fdashboard')
  })

  it('allows a signed-in user through the shared layout', async () => {
    getCurrentUser.mockResolvedValue({ id: 'user-a', role: 'USER' })
    const dashboard = <DashboardPage />
    await expect(AppLayout({ children: dashboard })).resolves.toBe(dashboard)
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
    expect(redirect).toHaveBeenCalledTimes(2)
  })

  it('rechecks the session when rendering the dashboard again', async () => {
    getCurrentUser.mockResolvedValueOnce({ id: 'user-a', role: 'USER' }).mockResolvedValueOnce(null)
    expect((await DashboardPage()).type).toBe('section')
    await expect(DashboardPage()).rejects.toThrow('Redirect to /sign-in?next=%2Fapp%2Fdashboard')
  })

  it('redirects the signed-in /app index to /app/dashboard', async () => {
    getCurrentUser.mockResolvedValue({ id: 'user-a', role: 'USER' })
    await expect(AppPage()).rejects.toThrow('Redirect to /app/dashboard')
    expect(redirect).toHaveBeenCalledWith('/app/dashboard')
  })
})
