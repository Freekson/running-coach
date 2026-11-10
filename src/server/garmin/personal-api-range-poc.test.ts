import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/server/provider/vault', () => ({
  apiKeySchema: { safeParse: (value: string) => ({ success: true, data: value }) },
}))

import { probeGarminHealthRange } from './personal-api-range-poc'

function responses(...items: Response[]) {
  const fetcher = vi.fn<typeof fetch>()
  for (const item of items) fetcher.mockResolvedValueOnce(item)
  return fetcher
}

const now = new Date('2026-11-09T12:00:00Z')
const start = '2026-11-06'
const end = '2026-11-08'

describe('Garmin health range probe', () => {
  it('requires explicit opt-in and a bounded completed range before any request', async () => {
    const fetcher = responses()
    await expect(
      probeGarminHealthRange('secret-key', start, end, false, { fetcher, now }),
    ).rejects.toThrow('disabled')
    await expect(
      probeGarminHealthRange('secret-key', '2026-11-01', end, true, { fetcher, now }),
    ).rejects.toThrow('two or three')
    await expect(
      probeGarminHealthRange('secret-key', '2026-11-07', '2026-11-09', true, {
        fetcher,
        now,
      }),
    ).rejects.toThrow('completed days')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('uses one token and two range GETs, and prints no values or credentials', async () => {
    const fetcher = responses(
      new Response('secret-token'),
      Response.json({
        data: [
          { calendarDate: start, heartRate: { restingValue: 55 } },
          { calendarDate: end, heartRate: { restingValue: 56 } },
        ],
      }),
      Response.json([
        { calendarDate: start, sleepTimeSeconds: 27000, userName: 'Private Athlete' },
      ]),
    )
    const pause = vi.fn(async () => {})
    const report = await probeGarminHealthRange('secret-key', start, end, true, {
      fetcher,
      pause,
      now,
    })
    expect(report.requestCount).toBe(3)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(pause).toHaveBeenCalledTimes(2)
    expect(String(fetcher.mock.calls[1][0])).toContain(`startDate=${start}&endDate=${end}`)
    expect(String(fetcher.mock.calls[2][0])).toContain('dailySleepSummariesByDate')
    expect(report.results[0]).toMatchObject({
      collection: 'data',
      recordCount: 2,
      coveredDates: [start, end],
      missingDates: ['2026-11-07'],
      firstRecordFieldTypes: { calendarDate: 'string', heartRate: 'object' },
    })
    expect(report.results[1]).toMatchObject({
      collection: 'root',
      recordCount: 1,
      coveredDates: [start],
      missingDates: ['2026-11-07', end],
      firstRecordFieldTypes: { sleepTimeSeconds: 'number', userName: 'string' },
    })
    expect(JSON.stringify(report)).not.toMatch(/secret|Private Athlete|27000|55|56/)
  })

  it('stops on a provider rate limit and never prints a failed response body', async () => {
    const fetcher = responses(
      new Response('secret-token'),
      new Response('private error body', { status: 429 }),
    )
    const report = await probeGarminHealthRange('secret-key', start, end, true, {
      fetcher,
      pause: async () => {},
      now,
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(report.requestCount).toBe(2)
    expect(report.results).toEqual([{ endpoint: 'daily-summaries', status: 429 }])
    expect(JSON.stringify(report)).not.toContain('private error body')
  })

  it('reports unrecognized sleep structure without inventing coverage', async () => {
    const fetcher = responses(
      new Response('secret-token'),
      Response.json({ data: [] }),
      Response.json({ aggregate: { nights: [] } }),
    )
    const report = await probeGarminHealthRange('secret-key', start, end, true, {
      fetcher,
      pause: async () => {},
      now,
    })
    expect(report.results[1]).toMatchObject({
      topLevelType: 'object',
      collection: 'unrecognized',
    })
    expect(report.results[1]).not.toHaveProperty('missingDates')
  })

  it('reports nested sleep summary date and types without exposing measurements', async () => {
    const fetcher = responses(
      new Response('secret-token'),
      Response.json({ data: [] }),
      Response.json({
        sleepSummaries: [{ dailySleepDTO: { calendarDate: start, sleepTimeSeconds: 27000 } }],
      }),
    )
    const report = await probeGarminHealthRange('secret-key', start, end, true, {
      fetcher,
      pause: async () => {},
      now,
    })
    expect(report.results[1]).toMatchObject({
      recordCount: 1,
      coveredDates: [start],
      firstRecordFieldTypes: {
        dailySleepDTO: 'object',
        'dailySleepDTO.calendarDate': 'string',
        'dailySleepDTO.sleepTimeSeconds': 'number',
      },
    })
    expect(JSON.stringify(report)).not.toContain('27000')
  })
})
