import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OwnerContext } from '@/server/authorization/ownership'

const { findScheduledGarminOwnerId, runGarminSync, allowGarminImport } = vi.hoisted(() => ({
  findScheduledGarminOwnerId: vi.fn(async () => '00000000-0000-4000-8000-000000000001'),
  allowGarminImport: vi.fn(async () => true),
  runGarminSync: vi.fn<(owner: OwnerContext) => Promise<{ status: string }>>(async () => ({
    status: 'PARTIAL',
  })),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/garmin/scheduled-sync', () => ({ findScheduledGarminOwnerId }))
vi.mock('@/server/garmin/sync', () => ({ runGarminSync }))
vi.mock('@/server/garmin/import-rate-limit', () => ({ allowGarminImport }))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: vi.fn() }))

import { ownerId } from '@/server/authorization/ownership'
import { CredentialUnavailableError } from '@/server/provider/credential-crypto'
import { GET } from './route'

const url = 'https://running.example/api/internal/garmin-sync'
const request = (secret?: string) =>
  new Request(url, { headers: secret ? { authorization: `Bearer ${secret}` } : {} })

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'synthetic-cron-secret'
  process.env.GARMIN_SCHEDULE_ENABLED = 'true'
})
afterEach(() => {
  delete process.env.CRON_SECRET
  delete process.env.GARMIN_SCHEDULE_ENABLED
})

describe('prepared Garmin scheduled trigger', () => {
  it('is unavailable while scheduling is disabled', async () => {
    delete process.env.GARMIN_SCHEDULE_ENABLED
    expect((await GET(request('synthetic-cron-secret'))).status).toBe(404)
    expect(findScheduledGarminOwnerId).not.toHaveBeenCalled()
  })

  it('rejects a missing or wrong secret before querying connections', async () => {
    expect((await GET(request())).status).toBe(401)
    expect((await GET(request('wrong'))).status).toBe(401)
    expect(findScheduledGarminOwnerId).not.toHaveBeenCalled()
  })

  it('does not run when scheduling is enabled but its bearer secret is unconfigured', async () => {
    delete process.env.CRON_SECRET
    expect((await GET(request('synthetic-cron-secret'))).status).toBe(401)
    expect(findScheduledGarminOwnerId).not.toHaveBeenCalled()
    expect(runGarminSync).not.toHaveBeenCalled()
  })

  it('runs only for the owner selected by the database', async () => {
    const response = await GET(request('synthetic-cron-secret'))
    expect(response.status).toBe(200)
    expect(findScheduledGarminOwnerId).toHaveBeenCalledOnce()
    expect(allowGarminImport).toHaveBeenCalledOnce()
    expect(ownerId(runGarminSync.mock.calls[0][0])).toBe('00000000-0000-4000-8000-000000000001')
  })

  it('does not start a scheduled job after the owner uses the shared attempt limit', async () => {
    allowGarminImport.mockResolvedValueOnce(false)
    expect((await GET(request('synthetic-cron-secret'))).status).toBe(204)
    expect(runGarminSync).not.toHaveBeenCalled()
  })

  it('skips an owner whose Garmin key was disconnected after selection', async () => {
    allowGarminImport.mockRejectedValueOnce(new CredentialUnavailableError())
    expect((await GET(request('synthetic-cron-secret'))).status).toBe(204)
    expect(runGarminSync).not.toHaveBeenCalled()
  })
})
