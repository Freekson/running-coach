import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  approve: vi.fn(),
  open: vi.fn(),
  revalidate: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }))
vi.mock('@/server/auth/current-user', () => ({
  getCurrentUser: mocks.user,
  isVerifiedCurrentUser: () => true,
  AccountUnavailableError: class extends Error {},
}))
vi.mock('@/server/plans/exchange/approve', () => ({ approvePlanImport: mocks.approve }))
vi.mock('@/server/plans/exchange/export', () => ({ openPlanExport: mocks.open }))
import { approveWizardPlanAction, openWizardDraftAction } from './actions'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.user.mockResolvedValue({
    id: '00000000-0000-4000-8000-000000000001',
    role: 'USER',
    email: null,
  })
})
it('requires a verified session for opening and approving', async () => {
  mocks.user.mockResolvedValue(null)
  expect((await openWizardDraftAction({})).success).toBe(false)
  expect((await approveWizardPlanAction({}, '{}')).success).toBe(false)
  expect(mocks.open).not.toHaveBeenCalled()
  expect(mocks.approve).not.toHaveBeenCalled()
})
it('opens an initial draft and derives the owner from the session', async () => {
  await openWizardDraftAction({ userId: 'forged' })
  expect(mocks.open).toHaveBeenCalledWith(
    expect.objectContaining({ userId: '00000000-0000-4000-8000-000000000001' }),
    { userId: 'forged' },
    { initialOnly: true },
  )
})
it('revalidates calendar and Training only after successful local approval', async () => {
  mocks.approve.mockResolvedValue({
    approved: false,
    validation: { valid: false, errors: [], repairPrompt: null },
  })
  await approveWizardPlanAction({}, '{}')
  expect(mocks.revalidate).not.toHaveBeenCalled()
  mocks.approve.mockResolvedValue({ approved: true, revisionNumber: 1 })
  await approveWizardPlanAction({ approve: true }, '{}')
  expect(mocks.revalidate.mock.calls).toEqual([['/app/calendar'], ['/app/training']])
})
it('rejects non-text uploads and does not leak infrastructure errors', async () => {
  expect((await approveWizardPlanAction({}, {})).success).toBe(false)
  expect(mocks.approve).not.toHaveBeenCalled()
  mocks.approve.mockRejectedValue(new Error('PRIVATE-DB-SECRET'))
  expect(JSON.stringify(await approveWizardPlanAction({}, '{}'))).not.toContain('PRIVATE')
})
