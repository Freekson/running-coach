import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getCurrentUser,
  isVerifiedCurrentUser,
  listActivities,
  getActivity,
  importGarminActivitiesForDate,
  allowGarminImport,
  withGarminProviderLease,
} = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  isVerifiedCurrentUser: vi.fn(() => true),
  listActivities: vi.fn(),
  getActivity: vi.fn(),
  importGarminActivitiesForDate: vi.fn(),
  allowGarminImport: vi.fn(),
  withGarminProviderLease: vi.fn(async (_owner: unknown, work: () => Promise<unknown>) => work()),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({
  AccountUnavailableError: class AccountUnavailableError extends Error {},
  getCurrentUser,
  isVerifiedCurrentUser,
}))
vi.mock('@/server/activity/import', () => ({
  InvalidActivityImportError: class InvalidActivityImportError extends Error {},
  listActivities,
  getActivity,
}))
vi.mock('@/server/garmin/activity-import', () => ({
  GarminImportError: class GarminImportError extends Error {},
  importGarminActivitiesForDate,
}))
vi.mock('@/server/garmin/import-rate-limit', () => ({ allowGarminImport }))
vi.mock('@/server/garmin/provider-lease', () => ({
  withGarminProviderLease,
  GarminProviderLeaseUnavailableError: class GarminProviderLeaseUnavailableError extends Error {},
}))

import { GET as list } from './route'
import { GET as detail } from './[id]/route'
import { POST as importActivities } from './import/route'
import { AccountUnavailableError } from '@/server/auth/current-user'

const id = '00000000-0000-4000-8000-000000000001'
const context = { params: Promise.resolve({ id }) }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: '00000000-0000-4000-8000-00000000000a', role: 'USER' })
  listActivities.mockResolvedValue({ items: [], nextCursor: null })
  getActivity.mockResolvedValue(null)
  importGarminActivitiesForDate.mockResolvedValue({ imported: [], hasMore: false, nextStart: null })
  allowGarminImport.mockResolvedValue(true)
})
afterEach(() => vi.unstubAllEnvs())

describe('activity routes', () => {
  it('uses only the session owner for paginated list and detail reads', async () => {
    const listed = await list(new Request('https://coach.example.test/api/activities?limit=2'))
    expect(listed.status).toBe(200)
    expect(listed.headers.get('Cache-Control')).toBe('private, no-store')
    expect(listActivities).toHaveBeenCalledWith(
      { userId: '00000000-0000-4000-8000-00000000000a' },
      2,
      undefined,
    )
    getCurrentUser.mockResolvedValue({ id: '00000000-0000-4000-8000-00000000000b', role: 'ADMIN' })
    const found = await detail(
      new Request('https://coach.example.test/api/activities/' + id),
      context,
    )
    expect(found.status).toBe(404)
    expect(getActivity).toHaveBeenCalledWith({ userId: '00000000-0000-4000-8000-00000000000b' }, id)
    expect(
      (await list(new Request('https://coach.example.test/api/activities?userId=other'))).status,
    ).toBe(400)
  })

  it('passes an opaque list cursor to the owner-scoped service', async () => {
    const response = await list(
      new Request('https://coach.example.test/api/activities?limit=2&cursor=eyJ2ZXJzaW9uIjoxfQ'),
    )
    expect(response.status).toBe(200)
    expect(listActivities).toHaveBeenCalledWith(
      { userId: '00000000-0000-4000-8000-00000000000a' },
      2,
      'eyJ2ZXJzaW9uIjoxfQ',
    )
    expect(
      (await list(new Request('https://coach.example.test/api/activities?cursor=bad%2Fvalue')))
        .status,
    ).toBe(400)
  })

  it('rejects unauthenticated, unavailable, and invalid requests before provider access', async () => {
    const request = () =>
      new Request('https://coach.example.test/api/activities/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: '2026-11-08' }),
      })
    getCurrentUser.mockResolvedValue(null)
    expect((await list(new Request('https://coach.example.test/api/activities'))).status).toBe(401)
    expect(
      (await detail(new Request('https://coach.example.test/api/activities/' + id), context))
        .status,
    ).toBe(401)
    expect((await importActivities(request())).status).toBe(401)
    getCurrentUser.mockRejectedValue(new AccountUnavailableError())
    expect((await importActivities(request())).status).toBe(403)
    getCurrentUser.mockResolvedValue({ id: '00000000-0000-4000-8000-00000000000a', role: 'USER' })
    const forged = new Request('https://coach.example.test/api/activities/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-11-08', userId: '00000000-0000-4000-8000-00000000000b' }),
    })
    expect((await importActivities(forged)).status).toBe(400)
    expect(
      (
        await detail(new Request('https://coach.example.test/api/activities/bad'), {
          params: Promise.resolve({ id: 'bad' }),
        })
      ).status,
    ).toBe(400)
    expect(importGarminActivitiesForDate).not.toHaveBeenCalled()
  })

  it('imports only for the authenticated owner with a bounded date request', async () => {
    const response = await importActivities(
      new Request('https://coach.example.test/api/activities/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: '2026-11-08', start: 3 }),
      }),
    )
    expect(response.status).toBe(200)
    expect(allowGarminImport).toHaveBeenCalledWith({
      userId: '00000000-0000-4000-8000-00000000000a',
    })
    expect(withGarminProviderLease).toHaveBeenCalledWith(
      { userId: '00000000-0000-4000-8000-00000000000a' },
      expect.any(Function),
    )
    expect(importGarminActivitiesForDate).toHaveBeenCalledWith(
      { userId: '00000000-0000-4000-8000-00000000000a' },
      '2026-11-08',
      { start: 3 },
    )
  })

  it('keeps the older manual import route gated on hosted deployments', async () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('GARMIN_SHARED_SYNC_APPROVED', undefined)
    const response = await importActivities(
      new Request('https://coach.example.test/api/activities/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: '2026-11-08' }),
      }),
    )
    expect(response.status).toBe(403)
    expect(allowGarminImport).not.toHaveBeenCalled()
    expect(importGarminActivitiesForDate).not.toHaveBeenCalled()
  })

  it('fails closed in production when the Vercel environment marker is missing', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VERCEL_ENV', undefined)
    vi.stubEnv('GARMIN_SHARED_SYNC_APPROVED', undefined)
    const response = await importActivities(
      new Request('https://coach.example.test/api/activities/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: '2026-11-08' }),
      }),
    )
    expect(response.status).toBe(403)
    expect(importGarminActivitiesForDate).not.toHaveBeenCalled()
  })

  it('rejects oversized import bodies before consuming the owner rate limit', async () => {
    const url = 'https://coach.example.test/api/activities/import'
    const streamed = new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-11-08', padding: 'é'.repeat(600) }),
    })
    expect(streamed.headers.get('content-length')).toBeNull()
    const response = await importActivities(streamed)
    expect(response.status).toBe(413)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(allowGarminImport).not.toHaveBeenCalled()
    expect(importGarminActivitiesForDate).not.toHaveBeenCalled()

    const advertised = new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '1025' },
      body: JSON.stringify({ date: '2026-11-08' }),
    })
    expect((await importActivities(advertised)).status).toBe(413)
    expect(allowGarminImport).not.toHaveBeenCalled()
  })

  it('returns 429 before contacting Garmin when the owner exhausts the shared limit', async () => {
    allowGarminImport.mockResolvedValue(false)
    const response = await importActivities(
      new Request('https://coach.example.test/api/activities/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: '2026-11-08' }),
      }),
    )
    expect(response.status).toBe(429)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(importGarminActivitiesForDate).not.toHaveBeenCalled()
  })

  it('returns safe provider error codes for rejected keys, denied access and rate limits', async () => {
    const { GarminImportError } = await import('@/server/garmin/activity-import')
    importGarminActivitiesForDate.mockRejectedValueOnce(
      Object.assign(new GarminImportError('INVALID_KEY'), { code: 'INVALID_KEY' }),
    )
    const response = await importActivities(
      new Request('https://coach.example.test/api/activities/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: '2026-11-08' }),
      }),
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'INVALID_KEY' })

    importGarminActivitiesForDate.mockRejectedValueOnce(
      Object.assign(new GarminImportError('ACCESS_DENIED'), { code: 'ACCESS_DENIED' }),
    )
    const denied = await importActivities(
      new Request('https://coach.example.test/api/activities/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: '2026-11-08' }),
      }),
    )
    expect(denied.status).toBe(502)
    expect(await denied.json()).toEqual({ error: 'ACCESS_DENIED' })

    importGarminActivitiesForDate.mockRejectedValueOnce(
      Object.assign(new GarminImportError('RATE_LIMITED'), { code: 'RATE_LIMITED' }),
    )
    const rateLimited = await importActivities(
      new Request('https://coach.example.test/api/activities/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: '2026-11-08' }),
      }),
    )
    expect(rateLimited.status).toBe(429)
    expect(await rateLimited.json()).toEqual({ error: 'RATE_LIMITED' })
  })
})
