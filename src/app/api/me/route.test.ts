import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getCurrentUserMock } = vi.hoisted(() => ({ getCurrentUserMock: vi.fn() }))

vi.mock('@/server/auth/current-user', () => ({
  AccountUnavailableError: class AccountUnavailableError extends Error {},
  getCurrentUser: getCurrentUserMock,
}))

import { AccountUnavailableError } from '@/server/auth/current-user'
import { GET } from './route'

beforeEach(() => vi.clearAllMocks())

describe('GET /api/me', () => {
  it('returns 401 when the session is absent or expired', async () => {
    getCurrentUserMock.mockResolvedValue(null)

    const response = await GET()
    expect(response.status).toBe(401)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.text()).toBe('')
  })

  it('returns only the active internal user identity without caching', async () => {
    getCurrentUserMock.mockResolvedValue({ id: 'internal-a', role: 'USER' })

    const response = await GET()
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ id: 'internal-a', role: 'USER' })
  })

  it('returns 403 for a suspended account', async () => {
    getCurrentUserMock.mockRejectedValue(new AccountUnavailableError())

    const response = await GET()
    expect(response.status).toBe(403)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.text()).toBe('')
  })
})
