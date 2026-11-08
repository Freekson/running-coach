import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OwnerContext } from '@/server/authorization/ownership'

const {
  getCurrentUser,
  getGarminSyncState,
  runGarminSync,
  isVerifiedCurrentUser,
  allowGarminImport,
} = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getGarminSyncState: vi.fn<(owner: OwnerContext) => Promise<{ status: string }>>(async () => ({
    status: 'IDLE',
  })),
  runGarminSync: vi.fn<(owner: OwnerContext) => Promise<{ status: string }>>(async () => ({
    status: 'PARTIAL',
  })),
  isVerifiedCurrentUser: vi.fn(() => true),
  allowGarminImport: vi.fn(async () => true),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({
  getCurrentUser,
  isVerifiedCurrentUser,
  AccountUnavailableError: class extends Error {},
}))
vi.mock('@/server/garmin/sync', () => ({
  getGarminSyncState,
  runGarminSync,
  GarminSyncUnavailableError: class extends Error {},
}))
vi.mock('@/server/db/client', () => ({ getPrismaClient: vi.fn() }))
vi.mock('@/server/garmin/import-rate-limit', () => ({ allowGarminImport }))

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
    expect(ownerId(getGarminSyncState.mock.calls[0][0])).toBe(user.id)
  })

  it('rejects oversized or invalid extension requests', async () => {
    expect((await POST(post(undefined, JSON.stringify({ extendDays: 29 })))).status).toBe(400)
    expect((await POST(post(undefined, 'x'.repeat(129)))).status).toBe(413)
    expect(runGarminSync).not.toHaveBeenCalled()
  })
})
