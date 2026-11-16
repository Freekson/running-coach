import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  open: vi.fn(),
  issue: vi.fn(),
  schedule: vi.fn(),
}))
vi.mock('@/server/auth/current-user', () => ({
  getCurrentUser: mocks.user,
  isVerifiedCurrentUser: () => true,
  AccountUnavailableError: class extends Error {},
}))
vi.mock('@/server/plans/exchange/export', () => ({
  openPlanExport: mocks.open,
  issuePlanExport: mocks.issue,
}))
vi.mock('@/server/plans/drafts', () => ({ updatePlanDraftConstraints: mocks.schedule }))
import { OwnedResourceNotFoundError } from '@/server/authorization/ownership'
import { openPlanExportAction, previewPlanExportAction, saveExportScheduleAction } from './actions'
beforeEach(() => {
  vi.clearAllMocks()
  mocks.user.mockResolvedValue({
    id: '00000000-0000-4000-8000-000000000001',
    role: 'USER',
    email: null,
  })
})
it('requires authentication for every public export action', async () => {
  mocks.user.mockResolvedValue(null)
  for (const response of [
    await openPlanExportAction({}),
    await previewPlanExportAction({}),
    await saveExportScheduleAction({}),
  ])
    expect(response.success).toBe(false)
  expect(mocks.open).not.toHaveBeenCalled()
  expect(mocks.issue).not.toHaveBeenCalled()
  expect(mocks.schedule).not.toHaveBeenCalled()
})
it('passes only a session-issued owner and never exposes private errors', async () => {
  mocks.issue.mockRejectedValue(new OwnedResourceNotFoundError())
  expect(await previewPlanExportAction({ userId: 'forged' })).toEqual({
    success: false,
    error: 'Goal or draft not found.',
  })
  expect(mocks.issue.mock.calls[0][0].userId).toBe('00000000-0000-4000-8000-000000000001')
  mocks.issue.mockRejectedValue(new Error('PRIVATE-DB-SECRET'))
  expect(JSON.stringify(await previewPlanExportAction({}))).not.toContain('PRIVATE')
})
