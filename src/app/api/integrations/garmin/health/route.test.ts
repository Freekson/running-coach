import { beforeEach, expect, it, vi } from 'vitest'
import type { OwnerContext } from '@/server/authorization/ownership'

const {
  getCurrentUser,
  isVerifiedCurrentUser,
  runGarminHealthSync,
  getGarminHealthSyncState,
  getHealthPreferredTimezone,
  allowGarminImport,
  getGarminImportBlock,
  verifySavedGarminAccount,
  healthInitialImportReady,
} = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  isVerifiedCurrentUser: vi.fn(() => true),
  runGarminHealthSync: vi.fn<(owner: OwnerContext, browserTimezone: string) => Promise<object>>(
    async () => ({ status: 'SUCCESS', nextDate: null }),
  ),
  getGarminHealthSyncState: vi.fn<
    () => Promise<{
      status: string
      lastSuccessAt: string | null
      nextAttemptAt?: string | null
      window?: { end: string }
      errorCode?: string | null
    }>
  >(async () => ({ status: 'IDLE', lastSuccessAt: null })),
  getHealthPreferredTimezone: vi.fn(async () => null),
  allowGarminImport: vi.fn(async () => true),
  getGarminImportBlock: vi.fn<
    () => Promise<{
      code: 'APP_RATE_LIMITED' | 'PROVIDER_PAUSED'
      retryAt: Date
    } | null>
  >(async () => null),
  verifySavedGarminAccount: vi.fn(async () => {}),
  healthInitialImportReady: vi.fn(async () => true),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({
  getCurrentUser,
  isVerifiedCurrentUser,
  AccountUnavailableError: class extends Error {},
}))
vi.mock('@/server/garmin/health-sync', () => ({
  runGarminHealthSync,
  getGarminHealthSyncState,
  localDay: (date: Date) => date.toISOString().slice(0, 10),
  GarminHealthSyncUnavailableError: class extends Error {},
}))
vi.mock('@/server/health/history', () => ({ getHealthPreferredTimezone }))
vi.mock('@/server/garmin/data-import', () => ({ healthInitialImportReady }))
vi.mock('@/server/garmin/health-import', () => ({
  GarminHealthImportError: class extends Error {},
}))
vi.mock('@/server/garmin/import-rate-limit', () => ({ allowGarminImport, getGarminImportBlock }))
vi.mock('@/server/garmin/account-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/garmin/account-identity')>()),
  verifySavedGarminAccount,
}))

import { ownerId } from '@/server/authorization/ownership'
import { GarminAccountIdentityError } from '@/server/garmin/account-identity'
import { POST } from './route'

const url = 'https://running.example/api/integrations/garmin/health'
const post = (
  body: unknown = { browserTimezone: 'Asia/Tokyo' },
  origin = 'https://running.example',
) =>
  new Request(url, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({
    id: '00000000-0000-4000-8000-000000000001',
    role: 'USER',
    email: null,
  })
  healthInitialImportReady.mockResolvedValue(true)
})

it('requires both initial health streams before incremental sync', async () => {
  healthInitialImportReady.mockResolvedValueOnce(false)
  const response = await POST(post())
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ code: 'INITIAL_IMPORT_REQUIRED' })
  expect(runGarminHealthSync).not.toHaveBeenCalled()
})

it('rejects unauthenticated, cross-origin and client-selected day requests', async () => {
  getCurrentUser.mockResolvedValueOnce(null)
  expect((await POST(post())).status).toBe(401)
  expect((await POST(post(undefined, 'https://other.example'))).status).toBe(403)
  expect((await POST(post({ browserTimezone: 'UTC', date: '2026-11-07' }))).status).toBe(400)
  expect(runGarminHealthSync).not.toHaveBeenCalled()
})

it('derives the owner from the verified session, including for an admin', async () => {
  const adminId = '00000000-0000-4000-8000-000000000002'
  getCurrentUser.mockResolvedValueOnce({ id: adminId, role: 'ADMIN', email: null })
  expect((await POST(post())).status).toBe(200)
  expect(ownerId(runGarminHealthSync.mock.calls[0][0])).toBe(adminId)
  expect(runGarminHealthSync.mock.calls[0][1]).toBe('Asia/Tokyo')
})

it('verifies a saved legacy key before the first health import without exposing it', async () => {
  getGarminHealthSyncState.mockResolvedValueOnce({
    status: 'ACTION_REQUIRED',
    errorCode: 'ACCOUNT_VERIFICATION_REQUIRED',
    lastSuccessAt: null,
  })
  expect((await POST(post())).status).toBe(200)
  expect(verifySavedGarminAccount).toHaveBeenCalledWith({
    userId: '00000000-0000-4000-8000-000000000001',
  })
  expect(verifySavedGarminAccount.mock.invocationCallOrder[0]).toBeLessThan(
    runGarminHealthSync.mock.invocationCallOrder[0],
  )
})

it('does not import when saved-key account verification fails', async () => {
  getGarminHealthSyncState.mockResolvedValueOnce({
    status: 'ACTION_REQUIRED',
    errorCode: 'ACCOUNT_VERIFICATION_REQUIRED',
    lastSuccessAt: null,
  })
  verifySavedGarminAccount.mockRejectedValueOnce(new GarminAccountIdentityError('UNVERIFIABLE'))
  const response = await POST(post())
  expect(response.status).toBe(422)
  expect(await response.json()).toEqual({ code: 'UNVERIFIABLE' })
  expect(runGarminHealthSync).not.toHaveBeenCalled()
})

it('applies the shared Garmin request limit before starting a sync', async () => {
  allowGarminImport.mockResolvedValueOnce(false)
  getGarminImportBlock.mockResolvedValueOnce({
    code: 'APP_RATE_LIMITED',
    retryAt: new Date('2026-11-09T06:01:00Z'),
  })
  const response = await POST(post())
  expect(response.status).toBe(429)
  expect(await response.json()).toEqual({
    code: 'APP_RATE_LIMITED',
    retryAt: '2026-11-09T06:01:00.000Z',
  })
  expect(runGarminHealthSync).not.toHaveBeenCalled()
})

it('does not verify a saved key while the shared request limit is active', async () => {
  getGarminHealthSyncState.mockResolvedValueOnce({
    status: 'ACTION_REQUIRED',
    errorCode: 'ACCOUNT_VERIFICATION_REQUIRED',
    lastSuccessAt: null,
  })
  allowGarminImport.mockResolvedValueOnce(false)
  expect((await POST(post())).status).toBe(429)
  expect(verifySavedGarminAccount).not.toHaveBeenCalled()
  expect(runGarminHealthSync).not.toHaveBeenCalled()
})

it('returns a recent successful state without consuming another import attempt', async () => {
  getGarminHealthSyncState.mockResolvedValueOnce({
    status: 'SUCCESS',
    lastSuccessAt: new Date().toISOString(),
    window: { end: new Date().toISOString().slice(0, 10) },
  })
  const response = await POST(post())
  expect(response.status).toBe(200)
  expect(allowGarminImport).not.toHaveBeenCalled()
  expect(runGarminHealthSync).not.toHaveBeenCalled()
})

it('does not apply the prior-day cooldown after the local date changes', async () => {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  getGarminHealthSyncState.mockResolvedValueOnce({
    status: 'SUCCESS',
    lastSuccessAt: new Date().toISOString(),
    window: { end: yesterday },
  })
  expect((await POST(post({ browserTimezone: 'UTC' }))).status).toBe(200)
  expect(allowGarminImport).toHaveBeenCalledOnce()
  expect(runGarminHealthSync).toHaveBeenCalledOnce()
})

it('rejects a known concurrent health job before the request limiter', async () => {
  getGarminHealthSyncState.mockResolvedValueOnce({ status: 'SYNCING', lastSuccessAt: null })
  expect((await POST(post())).status).toBe(409)
  expect(allowGarminImport).not.toHaveBeenCalled()
})

it('returns a paused checkpoint without consuming an import attempt', async () => {
  getGarminHealthSyncState.mockResolvedValueOnce({
    status: 'PAUSED',
    lastSuccessAt: null,
    nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
  })
  const response = await POST(post())
  expect(response.status).toBe(200)
  expect((await response.json()).status).toBe('PAUSED')
  expect(allowGarminImport).not.toHaveBeenCalled()
  expect(runGarminHealthSync).not.toHaveBeenCalled()
})

it('lets an interrupted window resume despite a recent previous completion', async () => {
  getGarminHealthSyncState.mockResolvedValueOnce({
    status: 'PARTIAL',
    lastSuccessAt: new Date().toISOString(),
  })
  expect((await POST(post())).status).toBe(200)
  expect(allowGarminImport).toHaveBeenCalledOnce()
  expect(runGarminHealthSync).toHaveBeenCalledOnce()
})

it('identifies a provider-requested pause separately from the app request limit', async () => {
  allowGarminImport.mockResolvedValueOnce(false)
  getGarminImportBlock.mockResolvedValueOnce({
    code: 'PROVIDER_PAUSED',
    retryAt: new Date('2026-11-09T06:05:00Z'),
  })
  const response = await POST(post())
  expect(response.status).toBe(429)
  expect(await response.json()).toEqual({
    code: 'PROVIDER_PAUSED',
    retryAt: '2026-11-09T06:05:00.000Z',
  })
})

it('returns a safe response for an unexpected server failure', async () => {
  runGarminHealthSync.mockRejectedValueOnce(new Error('private provider detail'))
  const response = await POST(post())
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: 'Health import unavailable' })
})

it('returns the generic rate limit when no retry metadata is available', async () => {
  allowGarminImport.mockResolvedValueOnce(false)
  const response = await POST(post())
  expect(response.status).toBe(429)
  expect(await response.json()).toEqual({ code: 'RATE_LIMITED', retryAt: null })
})
