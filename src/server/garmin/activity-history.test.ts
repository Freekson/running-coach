import { beforeEach, expect, it, vi } from 'vitest'

const { prisma, allow, claim, release, block, isVerified, assertSnapshot } = vi.hoisted(() => ({
  prisma: {
    integrationConnection: { findUnique: vi.fn() },
    athleteProfile: { findUnique: vi.fn() },
    syncCursor: { findFirst: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
    syncRun: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
  allow: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
  block: vi.fn(),
  isVerified: vi.fn(() => true),
  assertSnapshot: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: isVerified }))
vi.mock('@/server/db/client', () => ({ getPrismaClient: async () => prisma }))
vi.mock('./provider-lease', () => ({
  claimGarminProviderLease: claim,
  releaseGarminProviderLease: release,
}))
vi.mock('./import-rate-limit', () => ({ allowGarminImport: allow, getGarminImportBlock: block }))
vi.mock('@/server/provider/vault', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/provider/vault')>()),
  assertProviderApiKeySnapshotCurrent: assertSnapshot,
}))

import { getOwnerContext } from '@/server/authorization/ownership'
import { CredentialUnavailableError } from '@/server/provider/credential-crypto'
import { GarminImportError, type importGarminActivityPage } from './activity-import'
import {
  ACTIVITY_HISTORY_CURSOR,
  ACTIVITY_RECENT_CURSOR,
  activityHistoryWindow,
  activityHistoryRange,
  advanceActivityHistory,
  activityHistoryState,
  runActivityHistory,
  type ActivityHistoryCheckpoint,
} from './activity-history'

const owner = getOwnerContext({
  id: '00000000-0000-4000-8000-000000000001',
  role: 'USER',
  email: null,
})
const other = getOwnerContext({
  id: '00000000-0000-4000-8000-000000000002',
  role: 'ADMIN',
  email: null,
})
const now = new Date('2026-11-12T02:00:00Z')
let saved: ActivityHistoryCheckpoint | undefined
const emptyPage: typeof importGarminActivityPage = async () => ({
  imported: [],
  providerIds: [],
  pageIds: [],
  hasMore: false,
  nextStart: null,
  beforeCheckpoint: async () => {},
})

beforeEach(() => {
  vi.clearAllMocks()
  saved = undefined
  prisma.integrationConnection.findUnique.mockResolvedValue({
    id: 'connection-a',
    externalAccountId: 'synthetic-account',
    status: 'CONNECTED',
    credential: { nonce: new Uint8Array([1, 2, 3]) },
  })
  prisma.athleteProfile.findUnique.mockResolvedValue({ preferredTimezone: 'Asia/Tokyo' })
  prisma.syncCursor.findFirst.mockImplementation(async ({ where }) =>
    where.dataType === 'GARMIN_REQUESTS'
      ? { id: 'lease' }
      : saved
        ? { cursorOrCheckpoint: saved, consecutiveFailures: 0 }
        : null,
  )
  prisma.syncCursor.upsert.mockImplementation(async ({ create }) => {
    saved = create.cursorOrCheckpoint
  })
  prisma.syncCursor.updateMany.mockImplementation(async ({ data }) => {
    if (data.cursorOrCheckpoint) saved = data.cursorOrCheckpoint
    return { count: 1 }
  })
  prisma.syncRun.create.mockResolvedValue({ id: 'run-a' })
  prisma.$transaction.mockImplementation(async (work: (tx: typeof prisma) => Promise<unknown>) =>
    work(prisma),
  )
  allow.mockResolvedValue(true)
  claim.mockResolvedValue('provider-token')
  block.mockResolvedValue(null)
  assertSnapshot.mockResolvedValue(undefined)
})

it('uses the shared leap-safe calendar window and counts only verified ranges', () => {
  const cp = activityHistoryWindow('2024-03-01', 'Asia/Tokyo')
  expect(cp.startDate).toBe('2021-03-01')
  expect(cp.endDate).toBe('2024-02-29')
  const page = advanceActivityHistory(cp, ['1', '2'], ['1', '2'])
  expect(page.nextDate).toBe(cp.endDate)
  expect(page.offset).toBe(2)
  const verify = advanceActivityHistory(page, [], [])
  expect(verify.nextDate).toBe(cp.endDate)
  const again = advanceActivityHistory(verify, ['2', '1'], ['1', '2'])
  const checked = advanceActivityHistory(again, [], [])
  expect(checked.activityCount).toBe(2)
  expect(checked.nextDate).toBeNull()
})

it('traverses 62 synthetic activities, provider-capped short pages, overlaps and a changed dataset', () => {
  let cp = activityHistoryWindow('2026-11-12', 'UTC')
  const ids = Array.from({ length: 62 }, (_, index) => String(index + 1))
  for (const page of [ids.slice(0, 20), ids.slice(18, 38), ids.slice(38), []])
    cp = advanceActivityHistory(cp, page, page)
  expect(cp.nextDate).toBe('2026-11-11')
  // One record moves out between passes: another full pass must verify the changed set.
  const changed = ids.slice(1)
  cp = advanceActivityHistory(cp, changed, changed)
  cp = advanceActivityHistory(cp, [], [])
  expect(cp.nextDate).toBe('2026-11-11')
  cp = advanceActivityHistory(cp, changed, changed)
  cp = advanceActivityHistory(cp, [], [])
  expect(cp.activityCount).toBe(62)
  expect(cp.nextDate).toBeNull()
})

it('requires verified empty history and bounds endlessly changing pagination', () => {
  let cp = activityHistoryWindow('2026-11-12', 'UTC')
  let emptyPages = 0
  while (cp.nextDate) {
    cp = advanceActivityHistory(cp, [], [])
    emptyPages++
  }
  expect(emptyPages).toBe(2)
  expect(cp.activityCount).toBe(0)
  let changing = activityHistoryWindow('2026-11-12', 'UTC')
  expect(() => {
    for (let pass = 0; pass < 6; pass++) {
      changing = advanceActivityHistory(changing, [String(pass)], [String(pass)])
      changing = advanceActivityHistory(changing, [], [])
    }
  }).toThrow()
})

it('resumes a legacy 30-day checkpoint over all remaining history without losing prior coverage or counts', async () => {
  const legacy = {
    ...activityHistoryWindow('2026-11-12', 'UTC'),
    version: 1,
    nextDate: '2026-09-12',
    offset: 51,
    activityCount: 1,
    importedIds: ['1'],
    rangeIds: ['1'],
    passIds: ['1'],
    previousPassIds: ['1'],
    verificationPass: 1,
    pagesFetched: 9,
  }
  prisma.syncCursor.findFirst.mockImplementation(async ({ where }) =>
    where.dataType === 'GARMIN_REQUESTS'
      ? { id: 'lease' }
      : { cursorOrCheckpoint: saved ?? legacy, consecutiveFailures: 0 },
  )
  const page = vi.fn<typeof importGarminActivityPage>(async () => ({
    imported: [],
    providerIds: ['1', '2'],
    pageIds: ['1', '2'],
    hasMore: true,
    nextStart: 2,
    beforeCheckpoint: async () => {},
  }))
  await runActivityHistory(
    owner,
    { action: 'resume', browserTimezone: 'UTC' },
    { now: () => now, importActivityPage: page, maxPagesPerRun: 1 },
  )
  expect(page.mock.calls[0][1]).toMatchObject({
    start: 0,
    pageSize: 1000,
    summariesOnly: { startDate: legacy.startDate, endDate: '2026-09-12' },
  })
  expect(saved).toMatchObject({
    version: 2,
    generation: 1,
    nextDate: '2026-09-12',
    activityCount: 2,
    offset: 2,
    passIds: ['1', '2'],
    previousPassIds: null,
    verificationPass: 0,
    pagesFetched: 10,
  })
  const state = activityHistoryState(
    { cursorOrCheckpoint: saved!, leaseExpiresAt: null, nextAttemptAt: null, lastSyncedAt: now },
    true,
    null,
    null,
    now,
  )
  expect(state.checkedDays).toBe(60)
})

it('checks 62 activities across three years in four search pages without monthly requests', async () => {
  const ids = Array.from({ length: 62 }, (_, index) => String(index + 1))
  const page = vi.fn<typeof importGarminActivityPage>(async (_owner, window) => {
    const pageIds = window.start === 0 ? ids : []
    return {
      imported: pageIds.map((id) => ({ id, lapImportStatus: 'UNAVAILABLE' as const })),
      providerIds: pageIds,
      pageIds,
      hasMore: pageIds.length > 0,
      nextStart: pageIds.length ? pageIds.length : null,
      beforeCheckpoint: async () => {},
    }
  })
  await runActivityHistory(
    owner,
    { action: 'import', browserTimezone: 'UTC' },
    { now: () => now, importActivityPage: page },
  )
  expect(saved?.nextDate).not.toBeNull()
  await runActivityHistory(
    owner,
    { action: 'resume', browserTimezone: 'UTC' },
    { now: () => now, importActivityPage: page },
  )
  expect(page).toHaveBeenCalledTimes(4)
  expect(saved).toMatchObject({ activityCount: 62, pagesFetched: 4, nextDate: null })
  for (const [, window] of page.mock.calls) {
    expect(window.summariesOnly).toEqual({
      timezone: 'Asia/Tokyo',
      startDate: '2023-11-12',
      endDate: '2026-11-11',
    })
  }
})

it('rejects corrupt checkpoints and never infers historical completion from recent sync', () => {
  expect(activityHistoryState(undefined, true, null, null, now).status).toBe('not_started')
  expect(
    activityHistoryState(
      {
        cursorOrCheckpoint: { version: 1, mode: 'DONE' },
        leaseExpiresAt: null,
        nextAttemptAt: null,
        lastSyncedAt: now,
      },
      true,
      null,
      null,
      now,
    ),
  ).toMatchObject({ status: 'paused', errorCode: 'INVALID_CHECKPOINT' })
})

it('saves each page under the owner and resumes the same generation without touching health', async () => {
  const page = vi.fn(emptyPage)
  await runActivityHistory(
    owner,
    { action: 'import', browserTimezone: 'UTC' },
    { now: () => now, importActivityPage: page, maxPagesPerRun: 1 },
  )
  expect(saved?.verificationPass).toBe(1)
  await runActivityHistory(
    owner,
    { action: 'resume', browserTimezone: 'UTC' },
    { now: () => now, importActivityPage: page, maxPagesPerRun: 1 },
  )
  expect(saved?.generation).toBe(1)
  expect(saved?.pagesFetched).toBe(2)
  expect(saved?.nextDate).toBeNull()
  expect(page.mock.calls[0][1]).toMatchObject({
    start: 0,
    pageSize: 1000,
    startDate: '2023-11-10',
    endDate: '2026-11-13',
    summariesOnly: { timezone: 'Asia/Tokyo' },
  })
  for (const [args] of prisma.syncCursor.updateMany.mock.calls) {
    expect(args.where.userId).toBe(owner.userId)
    if (args.where.dataType !== 'GARMIN_REQUESTS')
      expect(args.where.dataType).toBe(ACTIVITY_HISTORY_CURSOR)
  }
  expect(release).toHaveBeenCalledTimes(2)
})

it.each([
  'ACCOUNT_MISMATCH',
  'TOKEN_REJECTED',
  'ACCESS_DENIED',
  'RATE_LIMITED',
  'TIMEOUT',
] as const)(
  'retains the last checkpoint and exposes %s without a false completion',
  async (code) => {
    block.mockResolvedValue({ retryAt: new Date(now.getTime() + 120_000) })
    await runActivityHistory(
      owner,
      { action: 'import', browserTimezone: 'UTC' },
      {
        now: () => now,
        importActivityPage: async () => {
          throw new GarminImportError(code)
        },
      },
    )
    expect(saved?.pagesFetched).toBe(0)
    expect(saved?.nextDate).not.toBeNull()
    expect(prisma.syncRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', errorCode: code }),
      }),
    )
    expect(prisma.syncCursor.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nextAttemptAt: ['ACCOUNT_MISMATCH', 'ACCESS_DENIED'].includes(code)
            ? null
            : new Date(now.getTime() + 120_000),
        }),
      }),
    )
    expect(release).toHaveBeenCalled()
  },
)

it('blocks concurrent runs and a different owner before any provider fetch', async () => {
  const page = vi.fn(emptyPage)
  claim.mockResolvedValueOnce(null)
  await expect(
    runActivityHistory(
      owner,
      { action: 'import', browserTimezone: 'UTC' },
      { importActivityPage: page },
    ),
  ).rejects.toThrow('BUSY')
  prisma.integrationConnection.findUnique.mockImplementation(async ({ where }) =>
    where.userId_provider.userId === owner.userId ? { id: 'connection-a' } : null,
  )
  await expect(
    runActivityHistory(
      other,
      { action: 'import', browserTimezone: 'UTC' },
      { importActivityPage: page },
    ),
  ).rejects.toThrow('NOT_CONNECTED')
  expect(page).not.toHaveBeenCalled()
})

it('never overwrites a newer checkpoint after rotation invalidates a planning request', async () => {
  saved = { ...activityHistoryWindow('2026-11-10', 'UTC'), nextDate: '2026-09-12' }
  const newer = { ...activityHistoryWindow('2026-11-12', 'UTC'), generation: 2 }
  allow.mockImplementationOnce(async () => {
    saved = newer
    assertSnapshot.mockRejectedValueOnce(new CredentialUnavailableError())
    return true
  })
  const page = vi.fn(emptyPage)
  await expect(
    runActivityHistory(
      owner,
      { action: 'resume', browserTimezone: 'UTC' },
      { now: () => now, importActivityPage: page },
    ),
  ).rejects.toBeInstanceOf(CredentialUnavailableError)
  expect(saved).toEqual(newer)
  expect(prisma.syncCursor.upsert).not.toHaveBeenCalled()
  expect(page).not.toHaveBeenCalled()
  expect(release).toHaveBeenCalled()
})

it('fences the initial checkpoint claim when another request has taken the provider lease', async () => {
  const newer = { ...activityHistoryWindow('2026-11-12', 'UTC'), generation: 2 }
  allow.mockImplementationOnce(async () => {
    saved = newer
    return true
  })
  prisma.syncCursor.updateMany.mockImplementation(async ({ where }) => ({
    count: where.dataType === 'GARMIN_REQUESTS' ? 0 : 1,
  }))
  const page = vi.fn(emptyPage)
  await expect(
    runActivityHistory(
      owner,
      { action: 'import', browserTimezone: 'UTC' },
      { now: () => now, importActivityPage: page },
    ),
  ).rejects.toThrow('BUSY')
  expect(saved).toEqual(newer)
  expect(prisma.syncCursor.upsert).not.toHaveBeenCalled()
  expect(page).not.toHaveBeenCalled()
})

it('rejects an unverified owner context without reading credentials or calling Garmin', async () => {
  const page = vi.fn(emptyPage)
  await expect(
    runActivityHistory(
      { userId: owner.userId },
      { action: 'import', browserTimezone: 'UTC' },
      { importActivityPage: page },
    ),
  ).rejects.toThrow('Verified owner context required')
  expect(prisma.integrationConnection.findUnique).not.toHaveBeenCalled()
  expect(page).not.toHaveBeenCalled()
})

it('does not save coverage after a key rotation or disconnect invalidates the snapshot', async () => {
  await runActivityHistory(
    owner,
    { action: 'import', browserTimezone: 'UTC' },
    {
      now: () => now,
      importActivityPage: async () => ({
        ...(await emptyPage(owner, { startDate: '2026-11-11', endDate: '2026-11-11', start: 0 })),
        pageIds: [],
        beforeCheckpoint: async () => {
          throw new CredentialUnavailableError()
        },
      }),
    },
  )
  expect(saved?.pagesFetched).toBe(0)
  expect(prisma.syncRun.update).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ errorCode: 'NOT_CONNECTED' }) }),
  )
  expect(release).toHaveBeenCalled()
})

it('rejects lost provider leases before fetching and before checkpoint writes', async () => {
  const page = vi.fn(emptyPage)
  prisma.syncCursor.findFirst.mockImplementation(async ({ where }) =>
    where.dataType === 'GARMIN_REQUESTS' ? null : null,
  )
  await runActivityHistory(
    owner,
    { action: 'import', browserTimezone: 'UTC' },
    { now: () => now, importActivityPage: page },
  )
  expect(page).not.toHaveBeenCalled()
  expect(saved?.pagesFetched).toBe(0)
})

it('starts incremental coverage at the last successful window with overlap, preserving history', async () => {
  saved = { ...activityHistoryWindow('2026-11-01', 'UTC'), nextDate: null }
  const history = saved
  prisma.syncCursor.findFirst.mockImplementation(async ({ where }) =>
    where.dataType === 'GARMIN_REQUESTS'
      ? { id: 'lease' }
      : where.dataType === ACTIVITY_HISTORY_CURSOR
        ? { cursorOrCheckpoint: history }
        : null,
  )
  await runActivityHistory(
    owner,
    { action: 'sync', browserTimezone: 'UTC' },
    { now: () => now, importActivityPage: emptyPage, maxPagesPerRun: 1 },
  )
  expect(prisma.syncCursor.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      create: expect.objectContaining({
        dataType: ACTIVITY_RECENT_CURSOR,
        cursorOrCheckpoint: expect.objectContaining({
          startDate: '2026-10-25',
          endDate: '2026-11-12',
        }),
      }),
    }),
  )
  expect(history.nextDate).toBeNull()
  expect(activityHistoryRange(saved!)).not.toBeNull()
})
