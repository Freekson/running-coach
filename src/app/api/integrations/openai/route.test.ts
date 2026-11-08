import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getCurrentUser, isVerifiedCurrentUser, getProviderConnectionStatus, disconnectProvider } =
  vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    isVerifiedCurrentUser: vi.fn(() => true),
    getProviderConnectionStatus: vi.fn(),
    disconnectProvider: vi.fn(),
  }))

vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({
  AccountUnavailableError: class AccountUnavailableError extends Error {},
  getCurrentUser,
  isVerifiedCurrentUser,
}))
vi.mock('@/server/provider/vault', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/provider/vault')>()),
  getProviderConnectionStatus,
  disconnectProvider,
}))

import * as route from './route'
import { AccountUnavailableError } from '@/server/auth/current-user'

const status = {
  provider: 'OPENAI',
  status: 'CONNECTED',
  createdAt: '2026-11-08T00:00:00.000Z',
  updatedAt: '2026-11-08T00:00:00.000Z',
}
const url = 'https://coach.example.test/api/integrations/openai'
const request = (origin = 'https://coach.example.test') =>
  new Request(url, {
    method: 'DELETE',
    headers: { Origin: origin },
  })

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'owner-a', role: 'USER', email: null })
  getProviderConnectionStatus.mockResolvedValue(status)
})

describe('OpenAI credential API', () => {
  it('does not allow saving OpenAI keys while retaining owner-scoped cleanup', async () => {
    expect(route).not.toHaveProperty('PUT')
    getCurrentUser.mockResolvedValue({ id: 'owner-b', role: 'ADMIN', email: null })
    const viewed = await route.GET()
    expect(viewed.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await viewed.json()).toEqual(status)
    expect(getProviderConnectionStatus).toHaveBeenCalledWith({ userId: 'owner-b' }, 'OPENAI')
    expect((await route.DELETE(request())).status).toBe(204)
    expect(disconnectProvider).toHaveBeenCalledWith({ userId: 'owner-b' }, 'OPENAI')
  })

  it('blocks unauthenticated, suspended and cross-origin cleanup', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await route.GET()).status).toBe(401)
    getCurrentUser.mockRejectedValue(new AccountUnavailableError())
    expect((await route.DELETE(request())).status).toBe(403)
    getCurrentUser.mockResolvedValue({ id: 'owner-a', role: 'USER', email: null })
    expect((await route.DELETE(request('https://other.test'))).status).toBe(403)
    expect(disconnectProvider).not.toHaveBeenCalled()
  })
})
