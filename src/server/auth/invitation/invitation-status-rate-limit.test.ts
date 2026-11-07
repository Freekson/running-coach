import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { getPrismaClient, queryRaw, executeRaw } = vi.hoisted(() => ({
  getPrismaClient: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/db/client', () => ({ getPrismaClient }))

import {
  allowInvitationStatusCheck,
  invitationStatusClientIp,
} from './invitation-status-rate-limit'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.BETTER_AUTH_SECRET = 'unit-test-secret'
  getPrismaClient.mockResolvedValue({ $queryRaw: queryRaw, $executeRaw: executeRaw })
})

afterEach(() => vi.restoreAllMocks())

it('blocks a client at the shared limit without blocking another client', async () => {
  const now = Date.now() + 2 * 60_000
  queryRaw
    .mockResolvedValueOnce([{ count: 60, lastRequest: BigInt(now) }])
    .mockResolvedValueOnce([{ count: 61, lastRequest: BigInt(now) }])
    .mockResolvedValueOnce([{ count: 1, lastRequest: BigInt(now) }])
  expect(await allowInvitationStatusCheck('192.0.2.1', now)).toBe(true)
  expect(await allowInvitationStatusCheck('192.0.2.1', now + 1)).toBe(false)
  expect(await allowInvitationStatusCheck('192.0.2.1', now + 2)).toBe(false)
  expect(await allowInvitationStatusCheck('192.0.2.2', now + 2)).toBe(true)
  expect(queryRaw).toHaveBeenCalledTimes(3)
})

it('rejects repeated checks locally before contacting Neon', async () => {
  const now = Date.now()
  queryRaw.mockResolvedValue([{ count: 1, lastRequest: BigInt(now) }])
  for (let i = 0; i < 20; i++)
    expect(await allowInvitationStatusCheck('192.0.2.3', now + i)).toBe(true)
  expect(await allowInvitationStatusCheck('192.0.2.3', now + 20)).toBe(false)
  expect(queryRaw).toHaveBeenCalledTimes(20)
})

it('runs bounded cleanup opportunistically without rejecting a valid check', async () => {
  const now = Date.now()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  queryRaw.mockResolvedValue([{ count: 1, lastRequest: BigInt(now) }])
  executeRaw.mockRejectedValue(new Error('cleanup unavailable'))
  expect(await allowInvitationStatusCheck('192.0.2.5', now)).toBe(true)
  expect(executeRaw).toHaveBeenCalledOnce()
})

it('requires a valid client IP on Vercel', async () => {
  const previous = process.env.VERCEL_ENV
  process.env.VERCEL_ENV = 'production'
  try {
    expect(invitationStatusClientIp(new Request('https://example.test'))).toBeNull()
    expect(
      invitationStatusClientIp(
        new Request('https://example.test', {
          headers: { 'x-forwarded-for': '192.0.2.4' },
        }),
      ),
    ).toBe('192.0.2.4')
    expect(await allowInvitationStatusCheck(null)).toBe(false)
    expect(queryRaw).not.toHaveBeenCalled()
  } finally {
    if (previous === undefined) delete process.env.VERCEL_ENV
    else process.env.VERCEL_ENV = previous
  }
})
