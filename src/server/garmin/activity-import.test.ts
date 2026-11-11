import { Encoder, Profile, type FileIdMesg, type LapMesg, type SessionMesg } from '@garmin/fitsdk'
import { describe, expect, it, vi } from 'vitest'

const {
  readProviderApiKeySnapshot,
  recordProviderApiKeyAccess,
  assertProviderApiKeySnapshotCurrent,
  pauseGarminProviderUntil,
  importCanonicalActivity,
  canSkipFitDownload,
  isVerifiedCurrentUser,
} = vi.hoisted(() => ({
  readProviderApiKeySnapshot: vi.fn(async () => ({
    key: 'synthetic-api-key',
    nonce: new Uint8Array([1, 2, 3]),
    accountId: '123456',
  })),
  recordProviderApiKeyAccess: vi.fn(async () => {}),
  assertProviderApiKeySnapshotCurrent: vi.fn(async () => {}),
  pauseGarminProviderUntil: vi.fn<
    (owner: unknown, until: Date, nonce: Uint8Array) => Promise<void>
  >(async () => {}),
  importCanonicalActivity: vi.fn<
    (owner: unknown, activity: unknown) => Promise<{ id: string; lapImportStatus: string }>
  >(async () => ({
    id: 'stored-id',
    lapImportStatus: 'IMPORTED',
  })),
  canSkipFitDownload: vi.fn(async () => false),
  isVerifiedCurrentUser: vi.fn(() => true),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser }))
vi.mock('@/server/db/client', () => ({ getPrismaClient: vi.fn() }))
vi.mock('@/server/provider/vault', async () => ({
  apiKeySchema: (await import('zod')).z.string().min(8),
  readProviderApiKeySnapshot,
  recordProviderApiKeyAccess,
  assertProviderApiKeySnapshotCurrent,
}))
vi.mock('@/server/activity/import', () => ({ importCanonicalActivity, canSkipFitDownload }))
vi.mock('./import-rate-limit', () => ({ pauseGarminProviderUntil }))
vi.mock('./account-identity', () => ({
  GarminAccountIdentityError: class GarminAccountIdentityError extends Error {},
  verifyGarminBearerAccount: vi.fn(async () => '123456'),
}))

import { getOwnerContext } from '@/server/authorization/ownership'
import {
  GarminImportError,
  importGarminActivitiesForDate,
  importGarminActivityPage,
} from './activity-import'
import { verifyGarminBearerAccount } from './account-identity'

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
    retryAfter?: string
    searchLimit?: string
    onRequest?: () => void
  } = {},
): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    options.onRequest?.()
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
      expect(url.searchParams.get('limit')).toBe(options.searchLimit ?? '4')
      expect(url.searchParams.get('startDate')).toBe(options.date ?? '2026-11-08')
      if (options.searchStatus && options.searchStatus !== 200)
        return new Response(null, {
          status: options.searchStatus,
          headers: options.retryAfter ? { 'retry-after': options.retryAfter } : undefined,
        })
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
  it('reuses account verification only for pages with the same saved credential', async () => {
    vi.clearAllMocks()
    const identitySession: { accountId?: string; credentialNonce?: Uint8Array } = {}
    const network = fetcher({ list: [] })
    const page = { startDate: '2026-11-08', endDate: '2026-11-08', start: 0 }
    await importGarminActivityPage(owner, page, {
      fetcher: network,
      pause: async () => {},
      identitySession,
    })
    await importGarminActivityPage(owner, page, {
      fetcher: network,
      pause: async () => {},
      identitySession,
    })
    expect(verifyGarminBearerAccount).toHaveBeenCalledTimes(1)
    readProviderApiKeySnapshot.mockResolvedValueOnce({
      key: 'synthetic-api-key',
      nonce: new Uint8Array([4, 5, 6]),
      accountId: '123456',
    })
    await importGarminActivityPage(owner, page, {
      fetcher: network,
      pause: async () => {},
      identitySession,
    })
    expect(verifyGarminBearerAccount).toHaveBeenCalledTimes(2)
  })

  it('refuses a changed Garmin account before searching or persisting activities', async () => {
    vi.clearAllMocks()
    vi.mocked(verifyGarminBearerAccount).mockResolvedValueOnce('999999')
    const network = fetcher()
    await expect(
      importGarminActivityPage(
        owner,
        {
          startDate: '2026-11-08',
          endDate: '2026-11-08',
          start: 0,
        },
        { fetcher: network, pause: async () => {} },
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' })
    expect(network).toHaveBeenCalledTimes(1)
    expect(importCanonicalActivity).not.toHaveBeenCalled()
  })
  it('checkpoints one completed activity when a two-activity page nears its deadline', async () => {
    vi.clearAllMocks()
    let elapsed = 0
    const network = fetcher({
      searchLimit: '3',
      list: [{ activityId: 321 }, { activityId: 322 }],
      onRequest: () => {
        elapsed += 4_000
      },
    })
    const result = await importGarminActivityPage(
      owner,
      { startDate: '2026-11-08', endDate: '2026-11-08', start: 0, pageSize: 2 },
      {
        fetcher: network,
        pause: async (milliseconds) => {
          elapsed += milliseconds
        },
        deadlineAt: 20_000,
        timeNow: () => elapsed,
      },
    )
    expect(result).toMatchObject({
      providerIds: ['321'],
      hasMore: true,
      nextStart: 1,
    })
    expect(result.imported).toHaveLength(1)
    expect(network).toHaveBeenCalledTimes(4)
  })

  it('stops before a detail request when the shared run deadline is exhausted', async () => {
    vi.clearAllMocks()
    let elapsed = 0
    const network = fetcher()
    await expect(
      importGarminActivityPage(
        owner,
        { startDate: '2026-11-08', endDate: '2026-11-08', start: 0 },
        {
          fetcher: network,
          pause: async (milliseconds) => {
            elapsed += milliseconds + 100
          },
          deadlineAt: 2_300,
          timeNow: () => elapsed,
        },
      ),
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(network).toHaveBeenCalledTimes(2)
    expect(importCanonicalActivity).not.toHaveBeenCalled()
  })
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

  it('skips recent FIT laps in historical pages and refreshes stale laps on incremental pages', async () => {
    vi.clearAllMocks()
    const observedAt = new Date('2026-11-08T12:00:00Z')
    canSkipFitDownload.mockResolvedValueOnce(true)
    const historicalNetwork = fetcher()
    await importGarminActivityPage(
      owner,
      { startDate: '2026-11-08', endDate: '2026-11-08', start: 0, refreshLaps: false },
      { fetcher: historicalNetwork, pause: async () => {}, observedAt: () => observedAt },
    )
    expect(historicalNetwork).toHaveBeenCalledTimes(3)
    expect(canSkipFitDownload).toHaveBeenCalledWith(owner, expect.anything(), {
      refresh: false,
      observedAt,
      garminAccountId: '123456',
    })
    expect(importCanonicalActivity).toHaveBeenCalledWith(
      owner,
      expect.anything(),
      expect.objectContaining({ fitCheckedAt: undefined }),
    )

    vi.clearAllMocks()
    canSkipFitDownload.mockResolvedValueOnce(false)
    const incrementalNetwork = fetcher()
    await importGarminActivityPage(
      owner,
      { startDate: '2026-11-08', endDate: '2026-11-08', start: 0, refreshLaps: true },
      { fetcher: incrementalNetwork, pause: async () => {}, observedAt: () => observedAt },
    )
    expect(incrementalNetwork).toHaveBeenCalledTimes(4)
    expect(canSkipFitDownload).toHaveBeenCalledWith(owner, expect.anything(), {
      refresh: true,
      observedAt,
      garminAccountId: '123456',
    })
    expect(importCanonicalActivity).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ laps: expect.any(Array) }),
      expect.objectContaining({ fitCheckedAt: observedAt }),
    )
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

  it('persists JSON but retries a transient FIT failure before advancing a sync page', async () => {
    vi.clearAllMocks()
    await expect(
      importGarminActivitiesForDate(owner, '2026-11-08', {
        fetcher: fetcher({ fitStatus: 503 }),
        pause: async () => {},
        now: new Date('2026-11-08T12:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE', persistedCount: 1 })
    expect(importCanonicalActivity).toHaveBeenCalledOnce()
    expect(importCanonicalActivity).toHaveBeenCalledWith(
      owner,
      expect.anything(),
      expect.objectContaining({ fitCheckedAt: undefined }),
    )
  })

  it.each([
    { status: 408, code: 'TIMEOUT' },
    { status: 400, code: 'INVALID_RESPONSE' },
  ])('does not complete a page after FIT returns $status', async ({ status, code }) => {
    vi.clearAllMocks()
    await expect(
      importGarminActivityPage(
        owner,
        { startDate: '2026-11-08', endDate: '2026-11-08', start: 0, pageSize: 1 },
        { fetcher: fetcher({ fitStatus: status, searchLimit: '2' }), pause: async () => {} },
      ),
    ).rejects.toMatchObject({ code, persistedCount: 1 })
    expect(importCanonicalActivity).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ laps: null }),
      expect.objectContaining({ fitCheckedAt: undefined }),
    )
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
    expect(pauseGarminProviderUntil).toHaveBeenCalledWith(
      owner,
      expect.any(Date),
      new Uint8Array([1, 2, 3]),
    )
  })

  it('records Garmin Retry-After on a search rate limit before importing a page', async () => {
    vi.clearAllMocks()
    const started = Date.now()
    await expect(
      importGarminActivitiesForDate(owner, '2026-11-08', {
        fetcher: fetcher({ searchStatus: 429, retryAfter: '300' }),
        pause: async () => {},
        now: new Date('2026-11-08T12:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    expect(importCanonicalActivity).not.toHaveBeenCalled()
    expect(pauseGarminProviderUntil).toHaveBeenCalledWith(
      owner,
      expect.any(Date),
      new Uint8Array([1, 2, 3]),
    )
    const until = pauseGarminProviderUntil.mock.calls[0][1] as Date
    expect(until.getTime()).toBeGreaterThanOrEqual(started + 300_000)
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

  it('retries a rejected short-lived token without rejecting the saved API key', async () => {
    vi.clearAllMocks()
    await expect(
      importGarminActivitiesForDate(owner, '2026-11-08', {
        fetcher: fetcher({ searchStatus: 401 }),
        pause: async () => {},
        now: new Date('2026-11-08T12:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'TOKEN_REJECTED' })
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
      {
        sourceObservedAt: observedAt,
        fitCheckedAt: observedAt,
        garminAccountId: '123456',
        beforeWrite: expect.any(Function),
      },
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
