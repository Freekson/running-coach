import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OwnerContext } from '@/server/authorization/ownership'

const {
  getCurrentUser,
  getGarminSyncState,
  runGarminSync,
  runLegacySync,
  isVerifiedCurrentUser,
  allowGarminImport,
  verifySavedGarminAccount,
  getGarminImportBlock,
} = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getGarminSyncState: vi.fn<
    (
      owner: OwnerContext,
    ) => Promise<{ status: string; errorCode?: string | null; nextAttemptAt?: string | null }>
  >(async () => ({ status: 'IDLE' })),
  runGarminSync: vi.fn<(owner: OwnerContext) => Promise<{ status: string }>>(async () => ({
    status: 'PARTIAL',
  })),
  runLegacySync: vi.fn(async () => ({ status: 'PARTIAL' })),
  isVerifiedCurrentUser: vi.fn(() => true),
  allowGarminImport: vi.fn(async () => true),
  getGarminImportBlock: vi.fn(
    async (): Promise<{ code: 'APP_RATE_LIMITED' | 'PROVIDER_PAUSED'; retryAt: Date } | null> =>
      null,
  ),
  verifySavedGarminAccount: vi.fn<(owner: OwnerContext) => Promise<void>>(async () => {}),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({
  getCurrentUser,
  isVerifiedCurrentUser,
  AccountUnavailableError: class extends Error {},
}))
vi.mock('@/server/garmin/sync', () => ({
  runGarminSync: runLegacySync,
  GarminSyncUnavailableError: class extends Error {},
}))
vi.mock('@/server/garmin/training-sync', () => ({
  getTrainingSyncState: getGarminSyncState,
  runTrainingSync: runGarminSync,
}))
vi.mock('@/server/db/client', () => ({ getPrismaClient: vi.fn() }))
vi.mock('@/server/garmin/import-rate-limit', () => ({ allowGarminImport, getGarminImportBlock }))
vi.mock('@/server/garmin/account-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/garmin/account-identity')>()),
  verifySavedGarminAccount,
}))

import { ownerId } from '@/server/authorization/ownership'
import { GET, POST } from './route'

const user = { id: '00000000-0000-4000-8000-000000000001', role: 'USER', email: null }
const admin = { id: '00000000-0000-4000-8000-000000000002', role: 'ADMIN', email: null }
const url = 'https://running.example/api/integrations/garmin/sync'
const post = (origin = 'https://running.example', body = '{}') =>
  new Request(url, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body,
  })

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(user)
})

describe('Garmin sync route authorization', () => {
  it('rejects unauthenticated and cross-origin requests before starting a job', async () => {
    getCurrentUser.mockResolvedValueOnce(null)
    expect((await POST(post())).status).toBe(401)
    expect((await POST(post('https://other.example'))).status).toBe(403)
    expect(runGarminSync).not.toHaveBeenCalled()
  })

  it('derives the owner from the verified session, including for an admin', async () => {
    getCurrentUser.mockResolvedValueOnce(admin)
    expect((await POST(post())).status).toBe(200)
    expect(ownerId(runGarminSync.mock.calls[0][0])).toBe(admin.id)
    getCurrentUser.mockResolvedValueOnce(user)
    expect((await GET()).status).toBe(200)
    expect(ownerId(getGarminSyncState.mock.calls.at(-1)![0])).toBe(user.id)
  })

  it('verifies a saved legacy key before importing activities', async () => {
    getGarminSyncState.mockResolvedValueOnce({
      status: 'ACTION_REQUIRED',
      errorCode: 'ACCOUNT_VERIFICATION_REQUIRED',
    })
    expect((await POST(post())).status).toBe(200)
    expect(ownerId(verifySavedGarminAccount.mock.calls[0][0])).toBe(user.id)
    expect(verifySavedGarminAccount.mock.invocationCallOrder[0]).toBeLessThan(
      runGarminSync.mock.invocationCallOrder[0],
    )
  })

  it('uses recent Training sync with the browser timezone and leaves quota reservation to its streams', async () => {
    const response = await POST(post(undefined, JSON.stringify({ browserTimezone: 'Asia/Tokyo' })))
    expect(response.status).toBe(200)
    expect(runGarminSync).toHaveBeenCalledWith(expect.anything(), 'Asia/Tokyo')
    expect(allowGarminImport).not.toHaveBeenCalled()
    expect(runLegacySync).not.toHaveBeenCalled()
  })

  it('retains explicit legacy extension requests without using them for ordinary Sync now', async () => {
    expect((await POST(post(undefined, JSON.stringify({ extendDays: 7 })))).status).toBe(200)
    expect(runLegacySync).toHaveBeenCalledWith(expect.anything(), { extendDays: 7 })
    expect(runGarminSync).not.toHaveBeenCalled()
  })

  it('does not verify a saved key while the shared request limit is active', async () => {
    getGarminSyncState.mockResolvedValueOnce({
      status: 'ACTION_REQUIRED',
      errorCode: 'ACCOUNT_VERIFICATION_REQUIRED',
    })
    allowGarminImport.mockResolvedValueOnce(false)
    expect((await POST(post())).status).toBe(429)
    expect(verifySavedGarminAccount).not.toHaveBeenCalled()
    expect(runGarminSync).not.toHaveBeenCalled()
  })

  it('returns an active sync backoff without consuming another shared attempt', async () => {
    const state = {
      status: 'PAUSED',
      errorCode: 'INVALID_RESPONSE',
      nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
    }
    getGarminSyncState.mockResolvedValueOnce(state)
    const response = await POST(post())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(state)
    expect(allowGarminImport).not.toHaveBeenCalled()
    expect(runGarminSync).not.toHaveBeenCalled()
  })

  it('reports the app request limit and exact retry time with Retry-After', async () => {
    const retryAt = new Date(Date.now() + 60_000)
    allowGarminImport.mockResolvedValueOnce(false)
    getGarminSyncState.mockResolvedValueOnce({
      status: 'ACTION_REQUIRED',
      errorCode: 'ACCOUNT_VERIFICATION_REQUIRED',
    })
    getGarminImportBlock.mockResolvedValueOnce({ code: 'APP_RATE_LIMITED', retryAt })
    const response = await POST(post())
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({
      code: 'APP_RATE_LIMITED',
      retryAt: retryAt.toISOString(),
    })
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(runGarminSync).not.toHaveBeenCalled()
  })

  it('rejects oversized or invalid extension requests', async () => {
    expect((await POST(post(undefined, JSON.stringify({ extendDays: 29 })))).status).toBe(400)
    expect((await POST(post(undefined, 'x'.repeat(257)))).status).toBe(413)
    expect(runGarminSync).not.toHaveBeenCalled()
  })
})
