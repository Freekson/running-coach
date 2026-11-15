import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  isVerifiedCurrentUser: vi.fn(() => true),
  connectIntervals: vi.fn(),
  testIntervalsConnection: vi.fn(),
  disconnectProvider: vi.fn(),
  getProviderConnectionStatus: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({
  ...mocks,
  AccountUnavailableError: class extends Error {},
}))
vi.mock('@/server/provider/vault', async (original) => ({
  ...(await original<typeof import('@/server/provider/vault')>()),
  disconnectProvider: mocks.disconnectProvider,
  getProviderConnectionStatus: mocks.getProviderConnectionStatus,
}))
vi.mock('@/server/intervals/connection', async (original) => ({
  ...(await original<typeof import('@/server/intervals/connection')>()),
  connectIntervals: mocks.connectIntervals,
  testIntervalsConnection: mocks.testIntervalsConnection,
}))

import * as route from './route'
import { AccountUnavailableError } from '@/server/auth/current-user'
import {
  CredentialConfigurationError,
  CredentialUnavailableError,
} from '@/server/provider/credential-crypto'
import { IntervalsConnectionError } from '@/server/intervals/connection'
import { CredentialWriteConflictError } from '@/server/provider/vault'

const url = 'https://coach.example.test/api/integrations/intervals'
const key = 'synthetic-owner-key'
const status = { provider: 'INTERVALS', status: 'KEY_SAVED', createdAt: null, updatedAt: null }
function request(
  method: string,
  body?: string,
  origin = 'https://coach.example.test',
  contentType = 'application/json',
) {
  return new Request(url, {
    method,
    headers: { Origin: origin, 'Content-Type': contentType },
    body,
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.isVerifiedCurrentUser.mockReturnValue(true)
  mocks.getCurrentUser.mockResolvedValue({ id: 'owner-a', role: 'USER', email: null })
  mocks.connectIntervals.mockResolvedValue(status)
  mocks.testIntervalsConnection.mockResolvedValue({ ...status, status: 'CONNECTED' })
  mocks.getProviderConnectionStatus.mockResolvedValue(status)
})

it.each(['owner-a', 'owner-b'])(
  'derives every operation from verified owner %s, including ADMIN',
  async (id) => {
    mocks.getCurrentUser.mockResolvedValue({
      id,
      role: id === 'owner-b' ? 'ADMIN' : 'USER',
      email: null,
    })
    const viewed = await route.GET()
    expect(await viewed.json()).toEqual(status)
    expect(mocks.getProviderConnectionStatus).toHaveBeenCalledWith({ userId: id }, 'INTERVALS')
    const saved = await route.PUT(request('PUT', JSON.stringify({ apiKey: key })))
    expect(await saved.json()).toEqual(status)
    expect(mocks.connectIntervals).toHaveBeenCalledWith({ userId: id }, key)
    const tested = await route.POST(request('POST', JSON.stringify({ userId: 'victim' })))
    expect(tested.status).toBe(200)
    expect(mocks.testIntervalsConnection).toHaveBeenCalledWith({ userId: id })
    const removed = await route.DELETE(request('DELETE'))
    expect(removed.status).toBe(204)
    expect(mocks.disconnectProvider).toHaveBeenCalledWith({ userId: id }, 'INTERVALS')
    for (const response of [viewed, saved, tested, removed])
      expect(response.headers.get('cache-control')).toBe('private, no-store')
  },
)

it.each([null, 'suspended'])(
  'rejects unauthenticated or unavailable accounts %s before provider access',
  async (state) => {
    if (state) mocks.getCurrentUser.mockRejectedValue(new AccountUnavailableError())
    else mocks.getCurrentUser.mockResolvedValue(null)
    const responses = [
      await route.GET(),
      await route.PUT(request('PUT', '{}')),
      await route.POST(request('POST')),
      await route.DELETE(request('DELETE')),
    ]
    expect(responses.map((response) => response.status)).toEqual(Array(4).fill(state ? 403 : 401))
    expect(mocks.connectIntervals).not.toHaveBeenCalled()
    expect(mocks.testIntervalsConnection).not.toHaveBeenCalled()
    expect(mocks.disconnectProvider).not.toHaveBeenCalled()
    expect(mocks.getProviderConnectionStatus).not.toHaveBeenCalled()
  },
)

it.each(['https://evil.test', 'null', ''])('rejects mutations with origin %s', async (origin) => {
  expect((await route.PUT(request('PUT', '{}', origin))).status).toBe(403)
  expect((await route.POST(request('POST', undefined, origin))).status).toBe(403)
  expect((await route.DELETE(request('DELETE', undefined, origin))).status).toBe(403)
  expect(mocks.connectIntervals).not.toHaveBeenCalled()
  expect(mocks.testIntervalsConnection).not.toHaveBeenCalled()
  expect(mocks.disconnectProvider).not.toHaveBeenCalled()
})

it.each([
  '{',
  '{}',
  '{"apiKey":"bad key"}',
  JSON.stringify({ apiKey: key, userId: 'victim' }),
  JSON.stringify({ apiKey: key, athleteId: 'i123' }),
])('rejects malformed keys or client ownership fields: %s', async (body) => {
  expect((await route.PUT(request('PUT', body))).status).toBe(400)
  expect(mocks.connectIntervals).not.toHaveBeenCalled()
})

it('bounds input without trusting Content-Length and checks media type', async () => {
  expect((await route.PUT(request('PUT', 'x'.repeat(4097)))).status).toBe(413)
  expect((await route.PUT(request('PUT', '{}', undefined, 'text/plain'))).status).toBe(415)
  expect(mocks.connectIntervals).not.toHaveBeenCalled()
})

it.each([
  [new IntervalsConnectionError('INVALID_KEY'), 422, 'INVALID_KEY'],
  [new IntervalsConnectionError('RATE_LIMITED'), 429, 'RATE_LIMITED'],
  [new IntervalsConnectionError('PROVIDER_UNAVAILABLE'), 503, 'PROVIDER_UNAVAILABLE'],
  [new CredentialConfigurationError(), 503, 'KEY_STORAGE_UNCONFIGURED'],
  [new CredentialUnavailableError(), 409, 'CREDENTIAL_UNAVAILABLE'],
  [new CredentialWriteConflictError(), 409, 'CONNECTION_CHANGED'],
  [new Error(`private ${key}`), 503, 'CONNECTION_UNAVAILABLE'],
])('returns only safe errors for %s', async (error, expectedStatus, code) => {
  mocks.testIntervalsConnection.mockRejectedValue(error)
  const response = await route.POST(request('POST'))
  expect(response.status).toBe(expectedStatus)
  expect(await response.json()).toEqual({ code })
  expect(response.headers.get('cache-control')).toBe('private, no-store')
})
