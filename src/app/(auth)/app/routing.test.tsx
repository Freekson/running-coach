import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { getCurrentUser, isVerifiedCurrentUser, redirect, requestPath, chartCookie } = vi.hoisted(
  () => ({
    getCurrentUser: vi.fn(),
    isVerifiedCurrentUser: vi.fn(() => true),
    requestPath: vi.fn(() => '/app/dashboard'),
    chartCookie: vi.fn(() => undefined as string | undefined),
    redirect: vi.fn((destination: string) => {
      throw new Error(`Redirect to ${destination}`)
    }),
  }),
)

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-running-coach-app-path': requestPath() }),
  cookies: async () => ({
    get: () => {
      const value = chartCookie()
      return value === undefined ? undefined : { value }
    },
  }),
}))
vi.mock('@/server/auth/current-user', () => ({
  AccountUnavailableError: class AccountUnavailableError extends Error {},
  getCurrentUser,
  isVerifiedCurrentUser,
}))
vi.mock('@/server/auth/invitation/invitation-management', () => ({
  listInvitations: vi.fn(async () => ({
    invitations: [],
    page: 1,
    total: 0,
    counts: { all: 0, pending: 0, processing: 0, used: 0, revoked: 0, expired: 0 },
  })),
  listRegisteredUsers: vi.fn(async () => ({ users: [], page: 1, total: 0 })),
}))
vi.mock('@/server/athlete/profile', () => ({
  getMeasurementSystem: vi.fn(async () => 'METRIC'),
  getAthleteProfile: vi.fn(async () => ({ measurementSystem: 'METRIC' })),
  getAthleteSettings: vi.fn(async () => ({
    profile: { measurementSystem: 'METRIC' },
    weights: [],
    chartWeights: [],
  })),
}))
vi.mock('@/server/provider/vault', () => ({
  getProviderConnectionStatus: vi.fn(async (_owner: unknown, provider: 'OPENAI' | 'GARMIN') => ({
    provider,
    status: 'DISCONNECTED',
    createdAt: null,
    updatedAt: null,
  })),
}))
vi.mock('@/server/activity/history', () => ({
  getDashboardActivityOverview: vi.fn(async () => ({ weeks: [], timezone: 'UTC' })),
  getDashboardRecentActivities: vi.fn(async () => []),
  getActivityHistory: vi.fn(async () => ({
    items: [],
    total: 0,
    importedCount: 0,
    page: 1,
    pageSize: 10,
    pageCount: 1,
    sports: [],
    providers: [],
    timezone: 'UTC',
    dateBounds: { min: '2020-01-01', max: '2026-11-12' },
    imported: false,
    savedAt: null,
  })),
}))
vi.mock('@/server/garmin/sync', () => ({
  getGarminSyncState: vi.fn(async () => ({
    status: 'NOT_CONNECTED',
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextAttemptAt: null,
    window: null,
    nextDate: null,
    processed: 0,
    errorCode: null,
  })),
}))
vi.mock('@/server/health/history', () => ({
  getHealthPreferredTimezone: vi.fn(async () => 'UTC'),
  getHealthTrendRows: vi.fn(async () => []),
  getHealthSnapshot: vi.fn(async () => ({
    restingHr: null,
    sleep: null,
    restingHrChecked: false,
    sleepChecked: false,
    lastUpdatedAt: null,
  })),
}))
vi.mock('@/server/garmin/health-sync', () => ({
  getGarminHealthSyncState: vi.fn(async () => ({
    status: 'NOT_CONNECTED',
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextAttemptAt: null,
    window: null,
    nextDate: null,
    processed: 0,
    errorCode: null,
  })),
}))
vi.mock('@/server/garmin/data-import', () => ({
  getGarminImportState: vi.fn(async () => []),
  healthInitialImportReady: vi.fn(async () => false),
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
import DashboardLoading from './dashboard/loading'
import { DashboardSkeleton } from './dashboard/dashboard-skeleton'
import TrainingPage from './training/page'
import { ActivityHistory } from './training/activity-history'
import {
  getActivityHistory,
  getDashboardActivityOverview,
  getDashboardRecentActivities,
} from '@/server/activity/history'
import { DashboardContent } from './dashboard/dashboard-content'
import SettingsPage from './settings/page'
import HealthPage from './health/page'
import HealthLoading from './health/loading'
import { HealthSkeleton } from './health/health-skeleton'
import AdminPage from './admin/page'
import { AppShell } from './app-shell'
import { AccountUnavailable } from './account-unavailable'
import { AccountUnavailableError } from '@/server/auth/current-user'
import {
  getAthleteProfile,
  getAthleteSettings,
  getMeasurementSystem,
} from '@/server/athlete/profile'
import { getProviderConnectionStatus } from '@/server/provider/vault'
import {
  getHealthTrendRows,
  getHealthPreferredTimezone,
  getHealthSnapshot,
} from '@/server/health/history'
import { HealthSyncPanel } from '@/components/health/HealthSyncPanel'
import { HealthHistoryPanel } from '@/components/health/HealthHistoryPanel'
import { WeightHistorySection } from './health/weight-history-section'

beforeEach(() => {
  vi.clearAllMocks()
  requestPath.mockReturnValue('/app/dashboard')
  chartCookie.mockReturnValue(undefined)
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
    requestPath.mockReturnValue('/app/training')
    await expect(AppLayout({ children: <TrainingPage /> })).rejects.toThrow(
      'Redirect to /sign-in?next=%2Fapp%2Ftraining',
    )
    await expect(TrainingPage()).rejects.toThrow('Redirect to /sign-in?next=%2Fapp%2Ftraining')
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
    for (const page of [TrainingPage, HealthPage, SettingsPage, AdminPage]) {
      await expect(page()).rejects.toThrow('Redirect to /sign-in?next=%2Fapp%2Fdashboard')
    }
    expect(redirect).toHaveBeenCalledTimes(6)
    expect(getActivityHistory).not.toHaveBeenCalled()
    expect(getAthleteSettings).not.toHaveBeenCalled()
    expect(getAthleteProfile).not.toHaveBeenCalled()
  })

  it('provides honest content for each linked route', async () => {
    getCurrentUser.mockResolvedValue({ id: 'user-a', role: 'USER', email: 'a@example.test' })
    const training = await TrainingPage()
    expect(training.type).toBe(AppShell)
    expect(training.props.children.props.children[1].type).toBe(ActivityHistory)
    expect(getActivityHistory).toHaveBeenCalledWith(
      { userId: 'user-a' },
      expect.objectContaining({ page: 1, range: 'all' }),
      { timezone: undefined },
    )
    const settings = await SettingsPage()
    expect(settings.type).toBe(AppShell)
    expect(settings.props.children.props.initial.profile.measurementSystem).toBe('METRIC')
    expect(getAthleteProfile).toHaveBeenCalledWith({ userId: 'user-a' })
    expect(getProviderConnectionStatus).toHaveBeenCalledWith({ userId: 'user-a' }, 'GARMIN')
    expect(settings.props.children.props.garminImportPreferenceKey).toBe(
      'running-coach:garmin-import-expanded:v1:user-a',
    )
    expect(getProviderConnectionStatus).toHaveBeenCalledTimes(1)
    const health = await HealthPage()
    expect(health.type).toBe(AppShell)
    expect(getHealthTrendRows).toHaveBeenCalledWith({ userId: 'user-a' }, null, expect.any(String))
    const healthHeader = health.props.children.props.children[0]
    expect(healthHeader.props.children[0].props.children[0].props.children).toBe(
      'Health & Recovery',
    )
    const healthSections = health.props.children.props.children
    expect(healthSections).toHaveLength(3)
    expect(healthSections[1].type).toBe(HealthHistoryPanel)
    expect(healthSections[2].type).toBe(WeightHistorySection)
    expect(healthHeader.props.children[1].type).toBe(HealthSyncPanel)
    expect(healthSections.at(-1).props.initialPeriod).toBe('7D')
    expect(healthSections.at(-1).props.initialWeights).toEqual([])
    expect(getAthleteSettings).toHaveBeenCalledWith({ userId: 'user-a' }, '7D')
  })

  it('validates Training query parameters and derives the owner from the session', async () => {
    getCurrentUser.mockResolvedValue({ id: 'athlete-a', role: 'USER', email: null })
    const result = await TrainingPage({
      searchParams: Promise.resolve({
        q: 'Trail',
        sport: 'RUNNING',
        page: '2',
        userId: 'another-owner',
      }),
    })
    expect(getActivityHistory).toHaveBeenCalledWith(
      { userId: 'athlete-a' },
      expect.objectContaining({ q: 'Trail', sport: 'RUNNING', page: 2 }),
      { timezone: undefined },
    )
    expect(result.props.children.props.children[1].type).toBe(ActivityHistory)
  })

  it('shows a safe Training read error and rejects invalid filters without querying history', async () => {
    getCurrentUser.mockResolvedValue({ id: 'athlete-a', role: 'USER', email: null })
    vi.mocked(getActivityHistory).mockRejectedValueOnce(new Error('private database details'))
    const failed = await TrainingPage()
    expect(failed.props.children.props.children[1].props.children.props.description).toContain(
      'could not be loaded',
    )
    expect(failed.props.children.props.children[1].props.children.props.description).not.toContain(
      'private',
    )
    vi.mocked(getActivityHistory).mockClear()
    const invalid = await TrainingPage({ searchParams: Promise.resolve({ pageSize: '99999' }) })
    expect(invalid.props.children.props.children[1].props.children.props.description).toContain(
      'filters are invalid',
    )
    expect(getActivityHistory).not.toHaveBeenCalled()
  })

  it('keeps the protected app shell during loading and uses the Dashboard skeleton without reading metrics', async () => {
    getCurrentUser.mockResolvedValue({ id: 'user-a', role: 'USER', email: 'a@example.test' })
    const loading = await HealthLoading()
    expect(loading.type).toBe(AppShell)
    expect(loading.props.children.type).toBe(HealthSkeleton)
    expect(getHealthTrendRows).not.toHaveBeenCalled()
    expect(getAthleteSettings).not.toHaveBeenCalled()
    const dashboardLoading = await DashboardLoading()
    expect(dashboardLoading.type).toBe(AppShell)
    expect(dashboardLoading.props.children.type).toBe(DashboardSkeleton)
    expect(getDashboardActivityOverview).not.toHaveBeenCalled()
    expect(getDashboardRecentActivities).not.toHaveBeenCalled()
  })

  it('restores a valid chart period and ignores an invalid cookie', async () => {
    getCurrentUser.mockResolvedValue({ id: 'user-a', role: 'USER', email: 'a@example.test' })
    chartCookie.mockReturnValue('30D')
    const selected = await HealthPage()
    expect(selected.props.children.props.children.at(-1).props.initialPeriod).toBe('30D')
    expect(getAthleteSettings).toHaveBeenLastCalledWith({ userId: 'user-a' }, '30D')

    chartCookie.mockReturnValue('invalid')
    const fallback = await HealthPage()
    expect(fallback.props.children.props.children.at(-1).props.initialPeriod).toBe('7D')
    expect(getAthleteSettings).toHaveBeenLastCalledWith({ userId: 'user-a' }, '7D')
  })

  it('loads the owner’s saved measurement system for protected pages', async () => {
    getCurrentUser.mockResolvedValue({ id: 'athlete-a', role: 'USER' })
    vi.mocked(getMeasurementSystem).mockResolvedValueOnce('IMPERIAL')
    const dashboard = await DashboardPage()
    expect(dashboard.props.measurementSystem).toBe('IMPERIAL')
    expect(getMeasurementSystem).toHaveBeenCalledWith({ userId: 'athlete-a' })
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

  it('loads Dashboard reads for the session owner using the configured timezone before the browser fallback', async () => {
    getCurrentUser.mockResolvedValueOnce({
      id: 'admin-a',
      role: 'ADMIN',
      displayName: 'Test Runner',
    })
    vi.mocked(getHealthPreferredTimezone).mockResolvedValueOnce('Asia/Tokyo')
    chartCookie.mockReturnValueOnce('America/New_York')
    const page = await DashboardPage()
    const content = page.props.children
    expect(content.type).toBe(DashboardContent)
    expect(content.props).toMatchObject({ timezone: 'Asia/Tokyo', name: 'Test Runner' })
    expect(getDashboardActivityOverview).toHaveBeenLastCalledWith(
      { userId: 'admin-a' },
      'Asia/Tokyo',
      expect.any(Date),
    )
    expect(getDashboardRecentActivities).toHaveBeenLastCalledWith(
      { userId: 'admin-a' },
      expect.any(Date),
    )
    expect(getHealthSnapshot).toHaveBeenLastCalledWith({ userId: 'admin-a' })
  })

  it('keeps Dashboard health and recent activities when training aggregates fail', async () => {
    vi.mocked(getDashboardActivityOverview).mockRejectedValueOnce(new Error('unavailable'))
    const page = await DashboardPage()
    expect(page.props.children.props).toMatchObject({
      overview: null,
      recent: [],
      health: expect.objectContaining({ restingHr: null }),
    })
  })

  it('uses a valid saved browser timezone when the Dashboard profile timezone is invalid', async () => {
    vi.mocked(getHealthPreferredTimezone).mockResolvedValueOnce('invalid')
    chartCookie.mockReturnValueOnce('America/New_York')
    expect((await DashboardPage()).props.children.props.timezone).toBe('America/New_York')
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
