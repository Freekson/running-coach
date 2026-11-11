import { expect, it, vi } from 'vitest'

const { getPrismaClient } = vi.hoisted(() => ({ getPrismaClient: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
vi.mock('@/server/db/client', () => ({ getPrismaClient }))

import { getOwnerContext } from '@/server/authorization/ownership'
import { GarminProviderLeaseUnavailableError, withGarminProviderLease } from './provider-lease'

const owner = getOwnerContext({
  id: '00000000-0000-4000-8000-000000000001',
  role: 'USER',
  email: null,
})

it('uses and releases the shared Garmin lease for a manual activity import', async () => {
  const upsert = vi.fn(async () => ({}))
  const updateMany = vi.fn(async (_args: unknown) => {
    void _args
    return { count: 1 }
  })
  const findUnique = vi.fn(async () => ({
    id: '00000000-0000-4000-8000-000000000010',
    status: 'CONNECTED',
    credential: { connectionId: '00000000-0000-4000-8000-000000000010' },
  }))
  getPrismaClient.mockResolvedValue({
    integrationConnection: { findUnique },
    syncCursor: { upsert, updateMany },
  })
  expect(await withGarminProviderLease(owner, async () => 'imported')).toBe('imported')
  expect(findUnique).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { userId_provider: { userId: owner.userId, provider: 'GARMIN' } },
    }),
  )
  expect(upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        connectionId_dataType: { connectionId: expect.any(String), dataType: 'GARMIN_REQUESTS' },
      },
    }),
  )
  expect(updateMany).toHaveBeenCalledTimes(2)
  expect(updateMany.mock.calls[1]?.[0]).toMatchObject({
    where: { userId: owner.userId, dataType: 'GARMIN_REQUESTS' },
    data: { leaseToken: null, leaseExpiresAt: null },
  })
})

it('rejects an occupied provider lease before manual import work runs', async () => {
  const work = vi.fn(async () => 'imported')
  getPrismaClient.mockResolvedValue({
    integrationConnection: {
      findUnique: vi.fn(async () => ({
        id: '00000000-0000-4000-8000-000000000010',
        status: 'CONNECTED',
        credential: { connectionId: '00000000-0000-4000-8000-000000000010' },
      })),
    },
    syncCursor: {
      upsert: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  })
  await expect(withGarminProviderLease(owner, work)).rejects.toBeInstanceOf(
    GarminProviderLeaseUnavailableError,
  )
  expect(work).not.toHaveBeenCalled()
})
