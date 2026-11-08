import { Encoder, Profile, type FileIdMesg, type LapMesg, type SessionMesg } from '@garmin/fitsdk'
import { describe, expect, it, vi } from 'vitest'

const {
  readProviderApiKeySnapshot,
  recordProviderApiKeyAccess,
  importCanonicalActivity,
  isVerifiedCurrentUser,
} = vi.hoisted(() => ({
  readProviderApiKeySnapshot: vi.fn(async () => ({
    key: 'synthetic-api-key',
    nonce: new Uint8Array([1, 2, 3]),
  })),
  recordProviderApiKeyAccess: vi.fn(async () => {}),
  importCanonicalActivity: vi.fn<
    (owner: unknown, activity: unknown) => Promise<{ id: string; lapImportStatus: string }>
  >(async () => ({
    id: 'stored-id',
    lapImportStatus: 'IMPORTED',
  })),
  isVerifiedCurrentUser: vi.fn(() => true),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser }))
vi.mock('@/server/db/client', () => ({ getPrismaClient: vi.fn() }))
vi.mock('@/server/provider/vault', async () => ({
  apiKeySchema: (await import('zod')).z.string().min(8),
  readProviderApiKeySnapshot,
  recordProviderApiKeyAccess,
}))
vi.mock('@/server/activity/import', () => ({ importCanonicalActivity }))

import { getOwnerContext } from '@/server/authorization/ownership'
import { GarminImportError, importGarminActivitiesForDate } from './activity-import'

const owner = getOwnerContext({
  id: '00000000-0000-4000-8000-000000000001',
  role: 'USER',
  email: null,
})
const detail = {
  activityId: 321,
  activityTypeDTO: { typeKey: 'running' },
  summaryDTO: {
    startTimeGMT: '2026-11-08 06:30:00',
    distance: 5000,
    duration: 1800,
    elapsedDuration: 1800,
  },
}

function fit(lapElapsedTime = 1800): Buffer {
  const encoder = new Encoder()
  const startTime = new Date('2026-11-08T06:30:00Z')
  const timestamp = new Date('2026-11-08T07:00:00Z')
  const fileId: FileIdMesg = {
    type: 'activity',
    manufacturer: 'development',
    product: 1,
    timeCreated: startTime,
  }
  const lap: LapMesg = {
    startTime,
    timestamp,
    totalElapsedTime: lapElapsedTime,
    totalDistance: 5000,
  }
  const session: SessionMesg = { startTime, timestamp, totalElapsedTime: 1800, totalDistance: 5000 }
  encoder.onMesg(Profile.MesgNum.FILE_ID, fileId)
  encoder.onMesg(Profile.MesgNum.LAP, lap)
  encoder.onMesg(Profile.MesgNum.SESSION, session)
  return Buffer.from(encoder.close())
}

function fetcher(
  options: {
    list?: unknown
    detail?: unknown
    fitStatus?: number
    fitBytes?: Buffer
    date?: string
    tokenStatus?: number
    searchStatus?: number
  } = {},
): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    expect(init?.cache).toBe('no-store')
    expect(init?.redirect).toBe('error')
    if (url.pathname.includes('/personal-api-key/token')) {
      expect(init?.headers).toMatchObject({ Authorization: 'ApiKey synthetic-api-key' })
      return options.tokenStatus === 401 || options.tokenStatus === 403
        ? new Response(null, { status: options.tokenStatus })
        : new Response('synthetic-bearer', { status: 200 })
    }
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer synthetic-bearer' })
    if (url.pathname.includes('/search/activities')) {
      expect(url.searchParams.get('limit')).toBe('4')
      expect(url.searchParams.get('startDate')).toBe(options.date ?? '2026-11-08')
      if (options.searchStatus === 403) return new Response(null, { status: 403 })
      return Response.json(options.list ?? [{ activityId: 321 }])
    }
    if (url.pathname.includes('/activity-service/activity/'))
      return Response.json(
        options.detail ?? { ...detail, activityId: Number(url.pathname.split('/').at(-1)) },
      )
    if (url.pathname.includes('/download-service/files/activity/'))
      return options.fitStatus && options.fitStatus !== 200
        ? new Response(null, { status: options.fitStatus })
        : new Response(new Uint8Array(options.fitBytes ?? fit()), { status: 200 })
    throw new Error('Unexpected provider route')
  }) as typeof fetch
}

describe('bounded Garmin activity import', () => {
  it('uses the owner vault and verifies detail plus FIT before persistence', async () => {
    vi.clearAllMocks()
    const result = await importGarminActivitiesForDate(owner, '2026-11-08', {
      fetcher: fetcher(),
      pause: async () => {},
      now: new Date('2026-11-08T12:00:00Z'),
    })
    expect(readProviderApiKeySnapshot).toHaveBeenCalledWith(owner, 'GARMIN')
    expect(recordProviderApiKeyAccess).toHaveBeenCalledWith(
      owner,
      'GARMIN',
      new Uint8Array([1, 2, 3]),
      'VERIFIED',
    )
    expect(importCanonicalActivity).toHaveBeenCalledOnce()
    expect(importCanonicalActivity.mock.calls[0][1]).toMatchObject({
      source: { userId: owner.userId, provider: 'GARMIN', externalActivityId: '321' },
      laps: [{ lapIndex: 0, distanceMeters: 5000 }],
    })
    expect(result.imported).toHaveLength(1)
  })

  it('keeps valid JSON when FIT is unavailable', async () => {
    vi.clearAllMocks()
    await importGarminActivitiesForDate(owner, '2026-11-08', {
      fetcher: fetcher({ fitStatus: 404 }),
      pause: async () => {},
      now: new Date('2026-11-08T12:00:00Z'),
    })
    expect(importCanonicalActivity.mock.calls[0][1]).toMatchObject({ laps: null })
  })

  it('saves verified JSON then stops before a second activity when Garmin rate-limits FIT', async () => {
    vi.clearAllMocks()
    const network = fetcher({
      list: [{ activityId: 321 }, { activityId: 322 }],
      fitStatus: 429,
    })
    await expect(
      importGarminActivitiesForDate(owner, '2026-11-08', {
        fetcher: network,
        pause: async () => {},
        now: new Date('2026-11-08T12:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    expect(network).toHaveBeenCalledTimes(4)
    expect(importCanonicalActivity).toHaveBeenCalledOnce()
    expect(importCanonicalActivity.mock.calls[0][1]).toMatchObject({ laps: null })
  })

  it('reports a rejected saved key without mislabeling it as an activity identity mismatch', async () => {
    vi.clearAllMocks()
    await expect(
      importGarminActivitiesForDate(owner, '2026-11-08', {
        fetcher: fetcher({ tokenStatus: 401 }),
        pause: async () => {},
        now: new Date('2026-11-08T12:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_KEY' })
    expect(recordProviderApiKeyAccess).toHaveBeenCalledWith(
      owner,
      'GARMIN',
      new Uint8Array([1, 2, 3]),
      'REJECTED',
    )
    expect(importCanonicalActivity).not.toHaveBeenCalled()
  })

  it('does not disable a saved key when the token endpoint denies access with 403', async () => {
    vi.clearAllMocks()
    await expect(
      importGarminActivitiesForDate(owner, '2026-11-08', {
        fetcher: fetcher({ tokenStatus: 403 }),
        pause: async () => {},
        now: new Date('2026-11-08T12:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(recordProviderApiKeyAccess).not.toHaveBeenCalled()
    expect(importCanonicalActivity).not.toHaveBeenCalled()
  })

  it('keeps API access denial distinct from a rejected saved key', async () => {
    vi.clearAllMocks()
    await expect(
      importGarminActivitiesForDate(owner, '2026-11-08', {
        fetcher: fetcher({ searchStatus: 403 }),
        pause: async () => {},
        now: new Date('2026-11-08T12:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(recordProviderApiKeyAccess).not.toHaveBeenCalled()
    expect(importCanonicalActivity).not.toHaveBeenCalled()
  })

  it('keeps verified JSON when only FIT Lap data is unusable', async () => {
    vi.clearAllMocks()
    const observedAt = new Date('2026-11-08T12:00:00Z')
    await importGarminActivitiesForDate(owner, '2026-11-08', {
      fetcher: fetcher({ fitBytes: fit(300) }),
      pause: async () => {},
      now: observedAt,
      observedAt: () => observedAt,
    })
    expect(importCanonicalActivity).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ laps: null }),
      { sourceObservedAt: observedAt },
    )
  })

  it('bounds one page and exposes the next explicit offset', async () => {
    vi.clearAllMocks()
    const result = await importGarminActivitiesForDate(owner, '2026-11-08', {
      start: 3,
      fetcher: fetcher({ list: [321, 322, 323, 324].map((activityId) => ({ activityId })) }),
      pause: async () => {},
      now: new Date('2026-11-08T12:00:00Z'),
    })
    expect(result.imported).toHaveLength(3)
    expect(result.hasMore).toBe(true)
    expect(result.nextStart).toBe(6)
  })

  it('fails closed when list and detail identity disagree or FIT does not match', async () => {
    vi.clearAllMocks()
    await expect(
      importGarminActivitiesForDate(owner, '2026-11-08', {
        fetcher: fetcher({ detail: { ...detail, activityId: 999 } }),
        pause: async () => {},
        now: new Date('2026-11-08T12:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' } satisfies Partial<GarminImportError>)
    expect(importCanonicalActivity).not.toHaveBeenCalled()
    await expect(
      importGarminActivitiesForDate(owner, '2026-11-08', {
        fetcher: fetcher({
          detail: { ...detail, summaryDTO: { ...detail.summaryDTO, distance: 9000 } },
        }),
        pause: async () => {},
        now: new Date('2026-11-08T12:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' })
    expect(importCanonicalActivity).not.toHaveBeenCalled()
  })

  it('returns safe codes for malformed provider data and storage failures', async () => {
    vi.clearAllMocks()
    await expect(
      importGarminActivitiesForDate(owner, '2026-11-08', {
        fetcher: fetcher({
          detail: { ...detail, summaryDTO: { ...detail.summaryDTO, distance: -1 } },
        }),
        pause: async () => {},
        now: new Date('2026-11-08T12:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(
      importGarminActivitiesForDate(owner, '2026-11-08', {
        fetcher: fetcher({ fitBytes: Buffer.from('corrupt') }),
        pause: async () => {},
        now: new Date('2026-11-08T12:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    importCanonicalActivity.mockRejectedValueOnce(new Error('private database details'))
    await expect(
      importGarminActivitiesForDate(owner, '2026-11-08', {
        fetcher: fetcher({ fitStatus: 404 }),
        pause: async () => {},
        now: new Date('2026-11-08T12:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
  })

  it('rejects forged owner context, stale dates and repeated list IDs without fetching details', async () => {
    vi.clearAllMocks()
    const dependency = {
      fetcher: fetcher({ list: [{ activityId: 321 }, { activityId: 321 }] }),
      pause: async () => {},
      now: new Date('2026-11-08T12:00:00Z'),
    }
    await expect(
      importGarminActivitiesForDate({ userId: owner.userId }, '2026-11-08', dependency),
    ).rejects.toThrow('Verified owner context required')
    await expect(
      importGarminActivitiesForDate(owner, '2026-10-01', dependency),
    ).rejects.toMatchObject({ code: 'INVALID_DATE' })
    await expect(
      importGarminActivitiesForDate(owner, '2026-11-08', dependency),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(importCanonicalActivity).not.toHaveBeenCalled()
  })

  it('accepts the next local calendar day when UTC is still the previous day', async () => {
    vi.clearAllMocks()
    const result = await importGarminActivitiesForDate(owner, '2026-11-09', {
      fetcher: fetcher({ list: [], date: '2026-11-09' }),
      pause: async () => {},
      now: new Date('2026-11-08T15:30:00Z'),
    })
    expect(result.imported).toEqual([])
  })
})
