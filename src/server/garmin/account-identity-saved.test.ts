import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { readSnapshot, saveKey } = vi.hoisted(() => ({
  readSnapshot: vi.fn(),
  saveKey: vi.fn(async () => {}),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
vi.mock('@/server/provider/vault', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/provider/vault')>()),
  readProviderApiKeySnapshot: readSnapshot,
  saveProviderApiKey: saveKey,
}))

import { getOwnerContext } from '@/server/authorization/ownership'
import { verifySavedGarminAccount } from './account-identity'

const owner = getOwnerContext({
  id: '00000000-0000-4000-8000-000000000001',
  role: 'USER',
  email: null,
})
const nonce = new Uint8Array([1, 2, 3])

beforeEach(() => {
  readSnapshot.mockReset()
  saveKey.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it('verifies the stored key and binds the account to the exact saved nonce', async () => {
  readSnapshot.mockResolvedValue({ key: 'synthetic-saved-key', nonce, accountId: null })
  const date = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('synthetic-token'))
    .mockResolvedValueOnce(Response.json({ calendarDate: date, userProfileId: 123456 }))
  vi.stubGlobal('fetch', fetchMock)

  await verifySavedGarminAccount(owner)

  expect(readSnapshot).toHaveBeenCalledWith(owner, 'GARMIN')
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(saveKey).toHaveBeenCalledWith(owner, 'GARMIN', 'synthetic-saved-key', {
    verifiedGarminAccountId: '123456',
    expectedCredentialNonce: nonce,
  })
})

it('does not repeat provider requests for an already verified account', async () => {
  readSnapshot.mockResolvedValue({ key: 'synthetic-saved-key', nonce, accountId: '123456' })
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)

  await verifySavedGarminAccount(owner)

  expect(fetchMock).not.toHaveBeenCalled()
  expect(saveKey).not.toHaveBeenCalled()
})
