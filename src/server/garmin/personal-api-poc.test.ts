import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readProviderApiKey } = vi.hoisted(() => ({ readProviderApiKey: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/provider/vault', () => ({
  apiKeySchema: { safeParse: (value: string) => ({ success: true, data: value }) },
  readProviderApiKey,
}))

import {
  probeGarminDataContracts,
  probeGarminDataContractsForOwner,
  probeGarminForOwner,
  probeGarminPersonalApi,
  requestFit,
  requestJson,
} from './personal-api-poc'

function responses(...items: Response[]) {
  const fetcher = vi.fn<typeof fetch>()
  for (const item of items) fetcher.mockResolvedValueOnce(item)
  return fetcher
}

const json = (value: unknown, status = 200) => Response.json(value, { status })

beforeEach(() => vi.clearAllMocks())

describe('Garmin Personal API PoC', () => {
  it.each([200, 204])('returns null for a successful empty JSON response (%i)', async (status) => {
    const fetcher = responses(new Response(null, { status }))
    expect(
      await requestJson(
        fetcher,
        '/sleep-service/sleep/dailySleep?date=2026-11-07',
        'Bearer synthetic',
      ),
    ).toEqual({ status, value: null })
  })
  it('passes a numeric Retry-After through both bounded request helpers', async () => {
    const fetcher = responses(
      new Response(null, { status: 429, headers: { 'Retry-After': '120' } }),
      new Response(null, { status: 429, headers: { 'Retry-After': '120' } }),
    )
    expect(
      await requestJson(
        fetcher,
        '/activitylist-service/activities/search/activities',
        'Bearer synthetic',
      ),
    ).toMatchObject({ status: 429, retryAfterMs: 120_000 })
    expect(
      await requestFit(fetcher, '/download-service/files/activity/1', 'Bearer synthetic'),
    ).toMatchObject({ status: 429, retryAfterMs: 120_000 })
  })
  it('bounds requests and returns structure without records, IDs or credentials', async () => {
    const fetcher = responses(
      new Response('secret-token'),
      json([{ activityId: 123456, activityName: 'Private run', distance: 5000 }]),
      json({ activityId: 123456, laps: [{ distance: 1000, latitude: 41.123 }] }),
      json({ lapDTOs: [{ distance: 1000, averageHR: 120 }] }),
      json({ restingHeartRate: 55 }),
      json({ sleepTimeSeconds: 27000 }),
      json({ hrvValue: 42 }),
      json({ bodyBattery: 70 }),
    )
    const pause = vi.fn(async () => {})
    const report = await probeGarminPersonalApi('user-owned-key', {
      fetcher,
      pause,
      now: new Date('2026-11-08T12:00:00Z'),
    })
    expect(fetcher).toHaveBeenCalledTimes(8)
    expect(pause).toHaveBeenCalledTimes(7)
    expect(report.results.map((result) => result.endpoint)).toEqual([
      'token',
      'activities',
      'activity-detail',
      'activity-laps',
      'daily-summary',
      'sleep',
      'hrv',
      'body-battery',
    ])
    expect(report.results[2].fields).toContain('laps[]: object')
    expect(JSON.stringify(report)).not.toMatch(
      /secret-token|user-owned-key|123456|Private run|41\.123/,
    )
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({
      Authorization: 'ApiKey user-owned-key',
      Accept: '*/*',
    })
    expect(fetcher.mock.calls[1][1]?.headers).toEqual({
      Authorization: 'Bearer secret-token',
      Accept: 'application/json',
    })
    for (const call of fetcher.mock.calls) {
      expect(call[1]?.signal).toBeInstanceOf(AbortSignal)
      expect(call[1]?.redirect).toBe('error')
      expect(call[1]?.cache).toBe('no-store')
    }
  })

  it('stops on a rate limit without retrying', async () => {
    const fetcher = responses(new Response('secret-token'), json({ error: 'secret' }, 429))
    const report = await probeGarminPersonalApi('user-owned-key', {
      fetcher,
      pause: async () => {},
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(report.results.at(-1)).toEqual({ endpoint: 'activities', status: 429 })
  })

  it('reads a Garmin key through the owner-scoped RUN-21 vault', async () => {
    const owner = { userId: 'owner-a' }
    readProviderApiKey.mockResolvedValue('user-owned-key')
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ error: 'denied' }, 401))
    await probeGarminForOwner(owner)
    expect(readProviderApiKey).toHaveBeenCalledWith(owner, 'GARMIN')
    expect(fetcher).toHaveBeenCalledTimes(1)
    fetcher.mockRestore()
  })

  it('does not call Garmin when the owner has no vault credential', async () => {
    readProviderApiKey.mockRejectedValue(new Error('Credential unavailable'))
    const fetcher = vi.spyOn(globalThis, 'fetch')
    await expect(probeGarminForOwner({ userId: 'other-owner' })).rejects.toThrow(
      'Credential unavailable',
    )
    expect(fetcher).not.toHaveBeenCalled()
    fetcher.mockRestore()
  })

  it('reports only contract structure for health and older activity searches', async () => {
    const fetcher = responses(
      new Response('secret-token'),
      json([]),
      json({ data: [{ heartRate: { restingValue: 54, secretValue: 333 } }] }),
      json({
        sleepStartTimestampGMT: 1_762_560_000_000,
        sleepStartTimestampLocal: 1_762_578_000_000,
      }),
      json({ hrvSummary: { lastNightAvg: 48 }, hrvReadings: [{ hrvValue: 51 }] }),
      json([
        {
          bodyBatteryValueDescriptorDTOList: [{ key: 'BODY_BATTERY' }],
          bodyBatteryValuesArray: [[123, 80]],
        },
      ]),
      json([{ activityId: 987654, activityName: 'Private older run' }]),
    )
    const report = await probeGarminDataContracts('user-owned-key', {
      fetcher,
      pause: async () => {},
      now: new Date('2026-11-08T12:00:00Z'),
    })
    expect(fetcher).toHaveBeenCalledTimes(7)
    expect(report.restingHeartRate).toEqual({
      heartRateFields: ['restingValue', 'secretValue'],
      restingFieldType: 'number',
    })
    expect(report.sleepTimestamps?.gmtLooksLikeEpochMilliseconds).toBe(true)
    expect(report.sleepTimestamps?.localMinusGmtLooksLikeTimezoneOffset).toBe(true)
    expect(report.hrv?.lastNightAvgType).toBe('number')
    expect(report.bodyBattery?.sampleElementTypes).toEqual(['number', 'number'])
    expect(report.historicalActivityPresent).toBe(true)
    expect(JSON.stringify(report)).not.toMatch(
      /secret-token|user-owned-key|987654|333|Private older run/,
    )
  })

  it('uses the owner-scoped vault for the contract probe and stops on unauthorized token', async () => {
    const owner = { userId: 'owner-b' }
    readProviderApiKey.mockResolvedValue('user-owned-key')
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({}, 401))
    const report = await probeGarminDataContractsForOwner(owner)
    expect(readProviderApiKey).toHaveBeenCalledWith(owner, 'GARMIN')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(report.results).toEqual([{ endpoint: 'token', status: 401 }])
    fetcher.mockRestore()
  })
})
