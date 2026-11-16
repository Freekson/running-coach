import { beforeEach, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  plans: vi.fn(),
  goals: vi.fn(),
  plan: vi.fn(),
  revisions: vi.fn(),
  revision: vi.fn(),
  measurement: vi.fn(),
}))
vi.mock('@/server/auth/current-user', () => ({
  getCurrentUser: mocks.user,
  isVerifiedCurrentUser: () => true,
  AccountUnavailableError: class extends Error {},
}))
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-running-coach-app-path': '/app/training/plan/refresh' }),
}))
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`Redirect ${path}`)
  },
}))
vi.mock('@/server/plans/refresh', () => ({ listApprovedPlans: mocks.plans }))
vi.mock('@/server/plans/revisions', () => ({
  getTrainingPlan: mocks.plan,
  listPlanRevisions: mocks.revisions,
  getPlanRevision: mocks.revision,
}))
vi.mock('@/server/goals/goals', () => ({ listGoals: mocks.goals }))
vi.mock('@/server/athlete/profile', () => ({ getMeasurementSystem: mocks.measurement }))
import RefreshPage from './refresh/page'
import HistoryPage from './[id]/page'
import { PlanWizardRoute } from './new/plan-wizard-route'
import { refreshChoice, refreshPreview } from './refresh/plan-refresh.fixtures'
import { wizardGoal } from './new/plan-wizard.fixtures'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.user.mockResolvedValue({ id: 'owner', role: 'USER', email: null })
  mocks.plans.mockResolvedValue([refreshChoice])
  mocks.goals.mockResolvedValue([wizardGoal])
  mocks.measurement.mockResolvedValue('METRIC')
  mocks.plan.mockResolvedValue({
    id: refreshChoice.id,
    currentRevisionId: refreshChoice.revisionId,
  })
  const revision = {
    id: refreshChoice.revisionId,
    revisionNumber: 1,
    approvedAt: new Date('2026-11-15T03:00:00Z'),
    snapshot: {
      schemaVersion: 1,
      macroPlan: refreshPreview.preview.refresh!.macroPlan,
      detailWindow: refreshPreview.preview.response.detailWindow,
      goal: wizardGoal,
      constraints: {
        sessionsPerWeek: 3,
        availableWeekdays: [0, 1, 2, 3, 4, 5, 6],
        maxSessionMinutes: 60,
        startDate: '2026-11-16',
        timezone: 'Asia/Tokyo',
      },
    },
    workouts: [],
  }
  mocks.revisions.mockResolvedValue([revision])
  mocks.revision.mockResolvedValue(revision)
})
const history = () =>
  HistoryPage({
    params: Promise.resolve({ id: refreshChoice.id }),
    searchParams: Promise.resolve({ revisionId: refreshChoice.revisionId }),
  })
it('requires authentication for both refresh selection and revision recovery', async () => {
  mocks.user.mockResolvedValue(null)
  await expect(RefreshPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
    'Redirect /sign-in',
  )
  await expect(history()).rejects.toThrow('Redirect /sign-in')
  expect(mocks.plans).not.toHaveBeenCalled()
  expect(mocks.revision).not.toHaveBeenCalled()
})
it('loads the selected approved plan into the shared wizard with owner-scoped reads', async () => {
  const page = await RefreshPage({ searchParams: Promise.resolve({ planId: refreshChoice.id }) })
  expect(mocks.plans).toHaveBeenCalledWith({ userId: 'owner' })
  expect(page.props.children.type).toBe(PlanWizardRoute)
  expect(page.props.children.props.refresh).toEqual(refreshChoice)
  mocks.user.mockResolvedValue({ id: 'different-admin', role: 'ADMIN', email: null })
  await RefreshPage({ searchParams: Promise.resolve({}) })
  expect(mocks.plans).toHaveBeenLastCalledWith({ userId: 'different-admin' })
})
it('offers an actionable selection when a URL refers to an unavailable plan', async () => {
  const page = await RefreshPage({ searchParams: Promise.resolve({ planId: 'foreign-plan' }) })
  expect(renderToStaticMarkup(page.props.children)).toContain('selected plan is unavailable')
})
it('keeps unavailable storage details out of refresh and history error screens', async () => {
  mocks.plans.mockRejectedValue(new Error('PRIVATE SQL'))
  mocks.plan.mockRejectedValue(new Error('PRIVATE SQL'))
  const refresh = renderToStaticMarkup(
    (await RefreshPage({ searchParams: Promise.resolve({}) })).props.children,
  )
  const saved = renderToStaticMarkup((await history()).props.children)
  expect(refresh).toContain('could not be loaded')
  expect(saved).toContain('plan or revision is unavailable')
  expect(refresh + saved).not.toContain('PRIVATE SQL')
})
it('reads the exact owned historical revision and offers a recoverable snapshot', async () => {
  const page = await history()
  expect(mocks.revision).toHaveBeenCalledWith(
    { userId: 'owner' },
    refreshChoice.id,
    refreshChoice.revisionId,
  )
  const html = renderToStaticMarkup(page.props.children)
  expect(html).toContain('Download revision snapshot')
  expect(html).toContain('Original approved snapshot JSON')
  mocks.user.mockResolvedValue({ id: 'different-admin', role: 'ADMIN', email: null })
  await history()
  expect(mocks.revision).toHaveBeenLastCalledWith(
    { userId: 'different-admin' },
    refreshChoice.id,
    refreshChoice.revisionId,
  )
})
