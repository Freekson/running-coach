import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getCurrentUser,
  isVerifiedCurrentUser,
  getProviderConnectionStatus,
  saveProviderApiKey,
  disconnectProvider,
  verifyGarminApiKeyAccount,
} = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  isVerifiedCurrentUser: vi.fn(() => true),
  getProviderConnectionStatus: vi.fn(),
  saveProviderApiKey: vi.fn(),
  disconnectProvider: vi.fn(),
  verifyGarminApiKeyAccount: vi.fn(),
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
  saveProviderApiKey,
  disconnectProvider,
}))
vi.mock('@/server/garmin/account-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/garmin/account-identity')>()),
  verifyGarminApiKeyAccount,
}))

import { DELETE, GET, PUT } from './route'
import { AccountUnavailableError } from '@/server/auth/current-user'
import { CredentialConfigurationError } from '@/server/provider/credential-crypto'
import { GarminAccountIdentityError } from '@/server/garmin/account-identity'
import { GarminAccountMismatchError } from '@/server/provider/vault'

const status = {
  provider: 'GARMIN',
  status: 'KEY_SAVED',
  createdAt: '2026-11-08T00:00:00.000Z',
  updatedAt: '2026-11-08T00:00:00.000Z',
}
const fakeKey = 'synthetic-test-api-key'
const url = 'https://coach.example.test/api/integrations/garmin'
const request = (method: 'PUT' | 'DELETE', body?: unknown, origin = 'https://coach.example.test') =>
  new Request(url, {
    method,
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'owner-a', role: 'USER', email: null })
  getProviderConnectionStatus.mockResolvedValue(status)
  saveProviderApiKey.mockResolvedValue(status)
  verifyGarminApiKeyAccount.mockResolvedValue('123456')
})

describe('Garmin credential API', () => {
  it('uses the verified session owner, including for an admin, and returns metadata only', async () => {
    const saved = await PUT(request('PUT', { apiKey: fakeKey }))
    expect(saved.status).toBe(200)
    expect(saved.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await saved.json()).toEqual(status)
    expect(saveProviderApiKey).toHaveBeenCalledWith({ userId: 'owner-a' }, 'GARMIN', fakeKey, {
      verifiedGarminAccountId: '123456',
    })
    getCurrentUser.mockResolvedValue({ id: 'owner-b', role: 'ADMIN', email: null })
    const viewed = await GET()
    expect(await viewed.json()).toEqual(status)
    expect(getProviderConnectionStatus).toHaveBeenCalledWith({ userId: 'owner-b' }, 'GARMIN')
    expect((await DELETE(request('DELETE'))).status).toBe(204)
    expect(disconnectProvider).toHaveBeenCalledWith({ userId: 'owner-b' }, 'GARMIN')
    expect(JSON.stringify([saved.status, status])).not.toContain(fakeKey)
  })

  it('blocks unauthenticated, suspended and cross-origin writes', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await PUT(request('PUT', { apiKey: fakeKey }))).status).toBe(401)
    expect((await GET()).status).toBe(401)
    getCurrentUser.mockRejectedValue(new AccountUnavailableError())
    expect((await DELETE(request('DELETE'))).status).toBe(403)
    getCurrentUser.mockResolvedValue({ id: 'owner-a', role: 'USER', email: null })
    expect((await PUT(request('PUT', { apiKey: fakeKey }, 'https://other.test'))).status).toBe(403)
    expect((await DELETE(request('DELETE', undefined, 'https://other.test'))).status).toBe(403)
    expect(saveProviderApiKey).not.toHaveBeenCalled()
    expect(disconnectProvider).not.toHaveBeenCalled()
  })

  it('does not serialize submitted keys in validation or storage errors', async () => {
    const invalid = await PUT(request('PUT', { apiKey: fakeKey, userId: 'owner-b' }))
    expect(invalid.status).toBe(400)
    expect(await invalid.text()).not.toContain(fakeKey)
    saveProviderApiKey.mockRejectedValue(new Error(`database failure ${fakeKey}`))
    const failed = await PUT(request('PUT', { apiKey: fakeKey }))
    expect(failed.status).toBe(503)
    expect(await failed.text()).not.toContain(fakeKey)
  })

  it('returns a safe code when credential encryption is not configured', async () => {
    saveProviderApiKey.mockRejectedValue(new CredentialConfigurationError())
    const failed = await PUT(request('PUT', { apiKey: fakeKey }))
    expect(failed.status).toBe(503)
    expect(await failed.json()).toEqual({ code: 'KEY_STORAGE_UNCONFIGURED' })
  })

  it('rejects a different or unverifiable account before changing the credential', async () => {
    saveProviderApiKey.mockRejectedValueOnce(new GarminAccountMismatchError('ACCOUNT_MISMATCH'))
    const mismatch = await PUT(request('PUT', { apiKey: fakeKey }))
    expect(mismatch.status).toBe(409)
    expect(await mismatch.json()).toEqual({ code: 'ACCOUNT_MISMATCH' })
    verifyGarminApiKeyAccount.mockRejectedValueOnce(new GarminAccountIdentityError('UNVERIFIABLE'))
    const unverifiable = await PUT(request('PUT', { apiKey: fakeKey }))
    expect(unverifiable.status).toBe(422)
    expect(await unverifiable.json()).toEqual({ code: 'UNVERIFIABLE' })
    expect(saveProviderApiKey).toHaveBeenCalledTimes(1)
  })
})
