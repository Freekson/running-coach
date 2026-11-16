import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({ user: vi.fn(), preview: vi.fn() }))
vi.mock('@/server/auth/current-user', () => ({
  getCurrentUser: mocks.user,
  isVerifiedCurrentUser: () => true,
  AccountUnavailableError: class extends Error {},
}))
vi.mock('@/server/plans/exchange/import', () => ({ previewPlanImport: mocks.preview }))
import { previewPlanImportAction } from './actions'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.user.mockResolvedValue({
    id: '00000000-0000-4000-8000-000000000001',
    role: 'USER',
    email: null,
  })
})
it('authenticates before inspecting a response or calling the validator', async () => {
  mocks.user.mockResolvedValue(null)
  expect((await previewPlanImportAction({}, '{}')).success).toBe(false)
  expect(mocks.preview).not.toHaveBeenCalled()
})
it('uses the verified session owner and returns only safe errors on infrastructure failure', async () => {
  mocks.preview.mockRejectedValue(new Error('PRIVATE-DB-KEY'))
  const result = await previewPlanImportAction({ userId: 'forged' }, '{}')
  expect(mocks.preview.mock.calls[0][0].userId).toBe('00000000-0000-4000-8000-000000000001')
  expect(JSON.stringify(result)).not.toContain('PRIVATE')
})
it('rejects non-text uploads before the domain service', async () => {
  expect((await previewPlanImportAction({}, {})).success).toBe(false)
  expect(mocks.preview).not.toHaveBeenCalled()
})
