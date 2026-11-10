import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getCurrentUser, isVerifiedCurrentUser, deleteAllImportedGarminData } = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  isVerifiedCurrentUser: vi.fn(() => true),
  deleteAllImportedGarminData: vi.fn(async () => {}),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({
  AccountUnavailableError: class AccountUnavailableError extends Error {},
  getCurrentUser,
  isVerifiedCurrentUser,
}))
vi.mock('@/server/provider/vault', () => ({ deleteAllImportedGarminData }))

import { DELETE } from './route'
import { AccountUnavailableError } from '@/server/auth/current-user'

const url = 'https://coach.example.test/api/integrations/garmin/data'
const request = (body: unknown, origin = 'https://coach.example.test') =>
  new Request(url, {
    method: 'DELETE',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({
    id: '00000000-0000-4000-8000-000000000001',
    role: 'USER',
    email: null,
  })
})

describe('destructive Garmin data endpoint', () => {
  it('requires a session, same origin and explicit confirmation', async () => {
    getCurrentUser.mockResolvedValueOnce(null)
    expect((await DELETE(request({ confirm: 'DELETE_ALL_GARMIN_DATA' }))).status).toBe(401)
    getCurrentUser.mockRejectedValueOnce(new AccountUnavailableError())
    expect((await DELETE(request({ confirm: 'DELETE_ALL_GARMIN_DATA' }))).status).toBe(403)
    expect(
      (await DELETE(request({ confirm: 'DELETE_ALL_GARMIN_DATA' }, 'https://elsewhere.test')))
        .status,
    ).toBe(403)
    expect((await DELETE(request({ confirm: 'no' }))).status).toBe(400)
    expect(
      (await DELETE(request({ confirm: 'DELETE_ALL_GARMIN_DATA', userId: 'other' }))).status,
    ).toBe(400)
    expect(deleteAllImportedGarminData).not.toHaveBeenCalled()
  })

  it('uses only the authenticated owner and returns no account data', async () => {
    const response = await DELETE(request({ confirm: 'DELETE_ALL_GARMIN_DATA' }))
    expect(response.status).toBe(204)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(deleteAllImportedGarminData).toHaveBeenCalledWith({
      userId: '00000000-0000-4000-8000-000000000001',
    })
  })
})
