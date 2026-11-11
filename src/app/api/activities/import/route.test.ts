import { expect, it, vi } from 'vitest'

const {
  getCurrentUser,
  allowGarminImport,
  importGarminActivitiesForDate,
  withGarminProviderLease,
} = vi.hoisted(() => ({
  getCurrentUser: vi.fn<() => Promise<{ id: string; role: 'USER'; email: null } | null>>(
    async () => ({
      id: '00000000-0000-4000-8000-000000000001',
      role: 'USER',
      email: null,
    }),
  ),
  allowGarminImport: vi.fn(async () => true),
  importGarminActivitiesForDate: vi.fn(async () => ({ imported: [] })),
  withGarminProviderLease: vi.fn(async (_owner: unknown, work: () => Promise<unknown>) => work()),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({
  getCurrentUser,
  isVerifiedCurrentUser: () => true,
  AccountUnavailableError: class AccountUnavailableError extends Error {},
}))
vi.mock('@/server/garmin/activity-import', () => ({
  importGarminActivitiesForDate,
  GarminImportError: class GarminImportError extends Error {},
}))
vi.mock('@/server/garmin/import-rate-limit', () => ({ allowGarminImport }))
vi.mock('@/server/garmin/sync-policy', () => ({ isGarminImportAllowed: () => true }))
vi.mock('@/server/garmin/provider-lease', () => ({
  withGarminProviderLease,
  GarminProviderLeaseUnavailableError: class GarminProviderLeaseUnavailableError extends Error {},
}))

import { POST } from './route'

it('runs manual Activities import inside the shared provider lease', async () => {
  vi.clearAllMocks()
  const response = await POST(
    new Request('http://localhost/api/activities/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-11-08' }),
    }),
  )
  expect(response.status).toBe(200)
  expect(withGarminProviderLease).toHaveBeenCalledOnce()
  expect(withGarminProviderLease.mock.calls[0]?.[0]).toMatchObject({
    userId: '00000000-0000-4000-8000-000000000001',
  })
  expect(importGarminActivitiesForDate).toHaveBeenCalledOnce()
})

it('does not enter the lease or import without an authenticated owner', async () => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValueOnce(null)
  const response = await POST(
    new Request('http://localhost/api/activities/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-11-08' }),
    }),
  )
  expect(response.status).toBe(401)
  expect(withGarminProviderLease).not.toHaveBeenCalled()
  expect(importGarminActivitiesForDate).not.toHaveBeenCalled()
})
