import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { GarminAccountIdentityError, verifyGarminApiKeyAccount } from './account-identity'

const now = new Date('2026-11-09T12:00:00Z')

function responses(...items: Response[]) {
  const fetcher = vi.fn<typeof fetch>()
  for (const item of items) fetcher.mockResolvedValueOnce(item)
  return fetcher
}

describe('Garmin account identity', () => {
  it('uses the legacy summary account ID after token exchange', async () => {
    const fetcher = responses(
      new Response('synthetic-token'),
      Response.json({ calendarDate: '2026-11-08', userProfileId: 123456 }),
    )
    expect(await verifyGarminApiKeyAccount('synthetic-key', { fetcher, now })).toBe('123456')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(String(fetcher.mock.calls[1][0])).toContain('usersummary/daily?calendarDate=2026-11-08')
  })

  it.each([
    { calendarDate: '2026-11-08' },
    { calendarDate: '2026-11-08', userProfileId: null },
    { calendarDate: '2026-11-08', userProfileId: '123456' },
    { calendarDate: '2026-11-08', userProfileId: 0 },
    { calendarDate: '2026-11-07', userProfileId: 123456 },
  ])('rejects a missing, malformed or wrong-day identity', async (record) => {
    const fetcher = responses(new Response('synthetic-token'), Response.json(record))
    await expect(
      verifyGarminApiKeyAccount('synthetic-key', { fetcher, now }),
    ).rejects.toMatchObject({
      code: 'UNVERIFIABLE',
    } satisfies Partial<GarminAccountIdentityError>)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('does not read account data after a rejected key', async () => {
    const fetcher = responses(new Response(null, { status: 401 }))
    await expect(
      verifyGarminApiKeyAccount('synthetic-key', { fetcher, now }),
    ).rejects.toMatchObject({
      code: 'INVALID_KEY',
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
