import { beforeEach, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
const mocks = vi.hoisted(() => ({
  db: {
    activity: { findFirst: vi.fn() },
    integrationConnection: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  lease: vi.fn(),
  quota: vi.fn(),
  block: vi.fn(),
  assertCurrent: vi.fn(),
  policy: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
vi.mock('@/server/db/client', () => ({ getPrismaClient: async () => mocks.db }))
vi.mock('@/server/provider/vault', () => ({
  assertProviderApiKeySnapshotCurrent: mocks.assertCurrent,
  apiKeySchema: { parse: (v: unknown) => v },
}))
vi.mock('@/server/garmin/import-rate-limit', () => ({
  allowGarminImport: mocks.quota,
  getGarminImportBlock: mocks.block,
}))
vi.mock('@/server/garmin/provider-lease', () => ({
  withGarminProviderLease: mocks.lease,
  GarminProviderLeaseUnavailableError: class extends Error {},
}))
vi.mock('@/server/garmin/sync-policy', () => ({ isGarminImportAllowed: mocks.policy }))
import { getOwnerContext } from '@/server/authorization/ownership'
import { CredentialUnavailableError } from '@/server/provider/credential-crypto'
import { GarminImportError } from '@/server/garmin/activity-import'
import { loadActivityCharts } from './charts'
import { recordsFit, recordsStart } from '@/server/garmin/activity-records.fixtures'
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
const id = '00000000-0000-4000-8000-000000000079'
const row = {
  id,
  sourceProvider: 'GARMIN',
  externalActivityId: '123456',
  garminAccountId: '79',
  startedAt: new Date(recordsStart),
  distanceMeters: new Prisma.Decimal(4000),
  elapsedMs: BigInt(1200_000),
  sportType: 'RUNNING',
  updatedAt: new Date(recordsStart),
}
const downloadFit = vi.fn()
const session = {
  fetcher: vi.fn(),
  authorization: 'Bearer synthetic',
  requestLimit: vi.fn(() => 8000),
  assertStatus: vi.fn(),
  credential: { nonce: new Uint8Array([7, 9]) },
}
const openSession = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  mocks.db.integrationConnection.findUnique.mockResolvedValue({
    externalAccountId: '79',
    status: 'CONNECTED',
    credential: { connectionId: 'connection' },
  })
  mocks.db.activity.findFirst.mockResolvedValue(row)
  mocks.db.$transaction.mockImplementation((work: (tx: typeof mocks.db) => unknown) =>
    work(mocks.db),
  )
  mocks.lease.mockImplementation((_owner: unknown, work: () => unknown) => work())
  mocks.quota.mockResolvedValue(true)
  mocks.policy.mockReturnValue(true)
  openSession.mockResolvedValue(session)
  downloadFit.mockResolvedValue({ status: 200, bytes: recordsFit() })
  session.assertStatus.mockResolvedValue(undefined)
  mocks.assertCurrent.mockResolvedValue(undefined)
})
// Only the injected dependency signatures are narrowed here; provider work is never performed.
function dependencies() {
  return { openSession: openSession, downloadFit }
}
it('uses owner-scoped identity, the shared lease/quota and rechecks credentials before returning records', async () => {
  const data = await loadActivityCharts(owner, id, dependencies())
  expect(data.samples).toHaveLength(121)
  expect(mocks.db.activity.findFirst.mock.calls[0][0].where).toMatchObject({
    AND: [{ userId: owner.userId }, { id }],
  })
  expect(mocks.lease).toHaveBeenCalledWith(owner, expect.any(Function))
  expect(mocks.quota).toHaveBeenCalledWith(owner)
  expect(openSession).toHaveBeenCalledWith(
    owner,
    expect.objectContaining({ expectedAccountId: '79' }),
  )
  expect(downloadFit).toHaveBeenCalledWith(
    session.fetcher,
    '/download-service/files/activity/123456',
    session.authorization,
    8000,
  )
  expect(mocks.assertCurrent).toHaveBeenCalledWith(
    mocks.db,
    owner,
    'GARMIN',
    session.credential.nonce,
    '79',
  )
  expect(mocks.db.activity.findFirst.mock.calls[1][0].where).toMatchObject({
    userId: owner.userId,
    id,
    updatedAt: row.updatedAt,
  })
  expect(data).not.toHaveProperty('authorization')
})
it('rejects another owner, unsafe IDs and unsupported sources before provider calls', async () => {
  mocks.db.activity.findFirst.mockResolvedValueOnce(null)
  await expect(loadActivityCharts(other, id, dependencies())).rejects.toMatchObject({
    code: 'NOT_FOUND',
    status: 404,
  })
  expect(mocks.db.activity.findFirst.mock.calls[0][0].where.AND[0].userId).toBe(other.userId)
  await expect(loadActivityCharts(owner, '../123', dependencies())).rejects.toThrow()
  mocks.db.activity.findFirst.mockResolvedValueOnce({ ...row, externalActivityId: '../private' })
  await expect(loadActivityCharts(owner, id, dependencies())).rejects.toMatchObject({
    code: 'UNSUPPORTED',
  })
  expect(openSession).not.toHaveBeenCalled()
  expect(mocks.quota).not.toHaveBeenCalled()
})
it('keeps disconnected saved activities readable without attempting a download', async () => {
  mocks.db.integrationConnection.findUnique.mockResolvedValue({
    externalAccountId: '79',
    status: 'DISCONNECTED',
    credential: null,
  })
  await expect(loadActivityCharts(owner, id, dependencies())).rejects.toMatchObject({
    code: 'NOT_CONNECTED',
  })
  expect(openSession).not.toHaveBeenCalled()
})
it('preserves cooldown dates and does not attempt provider work when quota is denied', async () => {
  const retryAt = new Date(Date.now() + 60_000)
  mocks.quota.mockResolvedValue(false)
  mocks.block.mockResolvedValue({ retryAt })
  await expect(loadActivityCharts(owner, id, dependencies())).rejects.toMatchObject({
    code: 'RATE_LIMITED',
    status: 429,
    retryAt,
  })
  expect(openSession).not.toHaveBeenCalled()
})
it.each([
  ['TOO_LARGE', 'FIT_TOO_LARGE'],
  [404, 'FIT_UNAVAILABLE'],
  [204, 'FIT_UNAVAILABLE'],
])('reports %s downloads safely', async (status, code) => {
  downloadFit.mockResolvedValue({ status })
  await expect(loadActivityCharts(owner, id, dependencies())).rejects.toMatchObject({ code })
})
it('applies provider 429 backoff and suppresses changed credentials or deleted activities', async () => {
  const retryAt = new Date(Date.now() + 60_000)
  session.assertStatus.mockRejectedValueOnce(new GarminImportError('RATE_LIMITED', 60_000))
  mocks.block.mockResolvedValue({ retryAt })
  await expect(loadActivityCharts(owner, id, dependencies())).rejects.toMatchObject({
    code: 'RATE_LIMITED',
    retryAt,
  })
  mocks.assertCurrent.mockRejectedValueOnce(new CredentialUnavailableError())
  await expect(loadActivityCharts(owner, id, dependencies())).rejects.toMatchObject({
    code: 'CREDENTIAL_CHANGED',
  })
  mocks.db.activity.findFirst.mockResolvedValueOnce(row).mockResolvedValueOnce(null)
  await expect(loadActivityCharts(owner, id, dependencies())).rejects.toMatchObject({
    code: 'NOT_FOUND',
  })
})

it.each(['TIMEOUT', 'NETWORK_ERROR'] as const)(
  'returns a safe %s state without writing or returning partial records',
  async (code) => {
    session.assertStatus.mockRejectedValueOnce(new GarminImportError(code))
    await expect(loadActivityCharts(owner, id, dependencies())).rejects.toMatchObject({
      code,
      status: 503,
    })
    expect(mocks.assertCurrent).not.toHaveBeenCalled()
  },
)
