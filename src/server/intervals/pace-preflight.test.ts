import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

const mocks = vi.hoisted(() => ({
  getPrismaClient: vi.fn(),
  readSnapshot: vi.fn(),
  assertCurrent: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
vi.mock('@/server/db/client', () => ({ getPrismaClient: mocks.getPrismaClient }))
vi.mock('@/server/provider/vault', async (original) => ({
  ...(await original<typeof import('@/server/provider/vault')>()),
  readProviderApiKeySnapshot: mocks.readSnapshot,
  assertProviderApiKeySnapshotCurrent: mocks.assertCurrent,
}))

import { getOwnerContext, ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { CredentialUnavailableError } from '@/server/provider/credential-crypto'
import { preflightIntervalsPace, prepareIntervalsWorkout } from './pace-preflight'
import { getIntervalsPaceStatus, INTERVALS_PACE_CHECKPOINT } from './pace-state'
import { intervalsWatchProbe } from './workout-mapping.fixtures'
import { INTERVALS_PACE_REFERENCE_PREFIX } from './pace-reference'

type Credential = { key: string; nonce: Uint8Array; connectionId: string }
type Cursor = {
  id: string
  userId: string
  connectionId: string
  dataType: string
  cursorOrCheckpoint: unknown
  leaseToken: string | null
  leaseExpiresAt: Date | null
}
type Update = {
  cursorOrCheckpoint?: unknown
  leaseToken?: string | null
  leaseExpiresAt?: Date | null
}
const credentials = new Map<string, Credential>()
const cursors = new Map<string, Cursor>()
const ownerA = getOwnerContext({ id: 'owner-a', role: 'USER', email: null })
const ownerB = getOwnerContext({ id: 'owner-b', role: 'ADMIN', email: null })
const valid = {
  id: 123,
  types: ['Run'],
  threshold_pace: 4,
  pace_zones: [80, 95, 105, 999],
  pace_zone_names: ['A', 'B', 'C', 'D'],
}

const db = {
  integrationConnection: {
    findUniqueOrThrow: vi.fn(
      async ({ where }: { where: { userId_provider: { userId: string } } }) => {
        const saved = credentials.get(where.userId_provider.userId)
        if (!saved) throw new CredentialUnavailableError()
        return { id: saved.connectionId }
      },
    ),
  },
  syncCursor: {
    upsert: vi.fn(
      async ({
        create,
        update,
      }: {
        create: Omit<Cursor, 'id' | 'leaseToken' | 'leaseExpiresAt'>
        update: Update
      }) => {
        const existing = [...cursors.values()].find(
          (row) => row.connectionId === create.connectionId && row.dataType === create.dataType,
        )
        if (existing) return Object.assign(existing, update)
        const row = {
          ...create,
          id: randomUUID(),
          leaseToken: null,
          leaseExpiresAt: null,
        }
        cursors.set(row.id, row)
        return row
      },
    ),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Update }) => {
      const row = cursors.get(where.id)
      if (!row) throw new Error('No cursor')
      Object.assign(row, data)
      return row
    }),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: {
          userId: string
          connectionId: string
          dataType: string
          leaseToken: string
          leaseExpiresAt: { gt: Date }
        }
        data: Update
      }) => {
        const row = [...cursors.values()].find(
          (item) =>
            item.userId === where.userId &&
            item.connectionId === where.connectionId &&
            item.dataType === where.dataType &&
            item.leaseToken === where.leaseToken &&
            item.leaseExpiresAt &&
            item.leaseExpiresAt > where.leaseExpiresAt.gt,
        )
        if (!row) return { count: 0 }
        Object.assign(row, data)
        return { count: 1 }
      },
    ),
    findFirst: vi.fn(
      async ({ where }: { where: { userId: string; connectionId?: string; dataType: string } }) =>
        [...cursors.values()].find(
          (row) =>
            row.userId === where.userId &&
            row.dataType === where.dataType &&
            (!where.connectionId || row.connectionId === where.connectionId),
        ) ?? null,
    ),
  },
}

let transactionTail = Promise.resolve()
async function transaction<T>(work: (tx: typeof db) => Promise<T>): Promise<T> {
  const previous = transactionTail
  let release = () => {}
  transactionTail = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await work(db)
  } finally {
    release()
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  credentials.clear()
  cursors.clear()
  transactionTail = Promise.resolve()
  credentials.set('owner-a', {
    key: 'synthetic-owner-a-key',
    nonce: new Uint8Array([1]),
    connectionId: 'connection-a',
  })
  credentials.set('owner-b', {
    key: 'synthetic-owner-b-key',
    nonce: new Uint8Array([2]),
    connectionId: 'connection-b',
  })
  mocks.getPrismaClient.mockResolvedValue({ ...db, $transaction: transaction })
  mocks.readSnapshot.mockImplementation(async (owner: OwnerContext) => {
    const credential = credentials.get(ownerId(owner))
    if (!credential) throw new CredentialUnavailableError()
    return { ...credential, nonce: Uint8Array.from(credential.nonce), accountId: null }
  })
  mocks.assertCurrent.mockImplementation(
    async (_tx: unknown, owner: OwnerContext, provider: string, nonce: Uint8Array) => {
      const credential = credentials.get(ownerId(owner))
      if (
        provider !== 'INTERVALS' ||
        !credential ||
        !Buffer.from(credential.nonce).equals(Buffer.from(nonce))
      )
        throw new CredentialUnavailableError()
    },
  )
})

function provider(initialA: object = valid, initialB: object = valid) {
  const settings = new Map([
    ['owner-a', structuredClone(initialA)],
    ['owner-b', structuredClone(initialB)],
  ])
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    const user = [...credentials].find(
      ([, saved]) =>
        new Headers(options?.headers).get('Authorization') ===
        `Basic ${Buffer.from(`API_KEY:${saved.key}`).toString('base64')}`,
    )?.[0]
    if (!user) return new Response(null, { status: 401 })
    expect(String(input)).toMatch(/^https:\/\/intervals\.icu\/api\/v1\/athlete\/0\/sport-settings/)
    if (options?.method === 'PUT') {
      const patch: unknown = JSON.parse(String(options.body))
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Bad patch')
      Object.assign(settings.get(user)!, patch)
      return Response.json(settings.get(user))
    }
    return Response.json([settings.get(user)])
  })
  return { settings, fetcher }
}

it('uses each verified owner key and checkpoint, including ADMIN, without cross-account access', async () => {
  const remote = provider({ id: 123, types: ['Run'] }, { ...valid, id: 456 })
  const a = await preflightIntervalsPace(ownerA, remote)
  expect(a.summary.source).toBe('technical-delivery-reference')
  expect(await getIntervalsPaceStatus(ownerB)).toEqual({
    status: 'NOT_CHECKED',
    source: null,
    verifiedAt: null,
  })
  const b = await preflightIntervalsPace(ownerB, remote)
  expect(b.summary.source).toBe('existing-user-configuration')
  expect(b.connectionId).toBe('connection-b')
  expect(a.connectionId).toBe('connection-a')
  expect(remote.settings.get('owner-b')).toEqual({ ...valid, id: 456 })
  expect(
    [...cursors.values()]
      .filter((row) => row.dataType === INTERVALS_PACE_CHECKPOINT)
      .map((row) => [row.userId, row.connectionId, row.dataType]),
  ).toEqual([
    ['owner-a', 'connection-a', INTERVALS_PACE_CHECKPOINT],
    ['owner-b', 'connection-b', INTERVALS_PACE_CHECKPOINT],
  ])
  expect(JSON.stringify([...cursors.values()])).not.toContain('synthetic-owner')
})

it('does not touch the provider or DB for a forged owner or a free-only workout', async () => {
  const remote = provider()
  await expect(preflightIntervalsPace({ userId: 'owner-b' }, remote)).rejects.toThrow(
    'Verified owner context required',
  )
  const result = await prepareIntervalsWorkout(
    ownerA,
    {
      workout: { ...intervalsWatchProbe, steps: [intervalsWatchProbe.steps[0]] },
      externalId: 'test',
      schedule: { localDate: '2026-11-16', timeZone: 'Asia/Tokyo' },
    },
    remote,
  )
  expect(result.configuration).toBeNull()
  expect(remote.fetcher).not.toHaveBeenCalled()
  expect(mocks.readSnapshot).not.toHaveBeenCalled()
})

it('retains valid settings byte-for-byte with no PUT', async () => {
  const remote = provider()
  await preflightIntervalsPace(ownerA, remote)
  expect(remote.fetcher).toHaveBeenCalledOnce()
  expect(remote.settings.get('owner-a')).toEqual(valid)
})

it('provisions absent fields once, preserving technical provenance on retry', async () => {
  const remote = provider({ id: 123, types: ['Run'] })
  const first = await preflightIntervalsPace(ownerA, remote)
  const second = await preflightIntervalsPace(ownerA, remote)
  expect(second.summary.source).toBe('technical-delivery-reference')
  expect(second.summary.verifiedAt).not.toBeNull()
  expect(first.credentialNonce).toEqual(second.credentialNonce)
  expect(remote.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1)
})

it('preserves a later user edit instead of resetting it to the technical constant', async () => {
  const remote = provider({ id: 123, types: ['Run'] })
  await preflightIntervalsPace(ownerA, remote)
  remote.settings.set('owner-a', structuredClone(valid))
  const result = await preflightIntervalsPace(ownerA, remote)
  expect(result.summary.source).toBe('existing-user-configuration')
  expect(remote.settings.get('owner-a')).toEqual(valid)
  expect(remote.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1)
})

it('retains technical provenance after credential invalidation without confusing another Run group', async () => {
  const remote = provider({ id: 123, types: ['Run'] })
  await preflightIntervalsPace(ownerA, remote)
  for (const [id, row] of cursors)
    if (!row.dataType.startsWith(INTERVALS_PACE_REFERENCE_PREFIX)) cursors.delete(id)
  credentials.set('owner-a', {
    key: 'synthetic-replacement-key',
    nonce: new Uint8Array([3]),
    connectionId: 'connection-a',
  })
  expect((await getIntervalsPaceStatus(ownerA)).status).toBe('NOT_CHECKED')
  const retried = await preflightIntervalsPace(ownerA, remote)
  expect(retried.summary.source).toBe('technical-delivery-reference')
  const checkpoint = [...cursors.values()].find(
    (row) => row.dataType === INTERVALS_PACE_CHECKPOINT,
  )!
  expect(checkpoint.cursorOrCheckpoint).toMatchObject({
    referenceVersion: 1,
    technicalReferenceMps: 1000 / 300,
  })
  remote.settings.set('owner-a', { ...valid, id: 789, threshold_pace: 1000 / 300 })
  expect((await preflightIntervalsPace(ownerA, remote)).summary.source).toBe(
    'existing-user-configuration',
  )
  expect(remote.fetcher.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(
    1,
  )
})

it('does not borrow another owner technical provenance even for the same provider group ID and pace', async () => {
  const remote = provider({ id: 123, types: ['Run'] }, { ...valid, threshold_pace: 1000 / 300 })
  await preflightIntervalsPace(ownerA, remote)
  expect((await preflightIntervalsPace(ownerB, remote)).summary.source).toBe(
    'existing-user-configuration',
  )
  expect(
    [...cursors.values()]
      .filter((row) => row.dataType.startsWith(INTERVALS_PACE_REFERENCE_PREFIX))
      .map((row) => row.userId),
  ).toEqual(['owner-a'])
})

it('fails closed on corrupt reference metadata rather than reclassifying it as user configuration', async () => {
  const remote = provider({ id: 123, types: ['Run'] })
  await preflightIntervalsPace(ownerA, remote)
  const reference = [...cursors.values()].find((row) =>
    row.dataType.startsWith(INTERVALS_PACE_REFERENCE_PREFIX),
  )!
  reference.cursorOrCheckpoint = { version: 1, settingsId: 999 }
  await expect(preflightIntervalsPace(ownerA, remote)).rejects.toMatchObject({
    code: 'CONFIGURATION_CONFLICT',
  })
  expect((await getIntervalsPaceStatus(ownerA)).status).toBe('FAILED')
})

it('rejects an expired lease before any provider settings write', async () => {
  const remote = provider({ id: 123, types: ['Run'] })
  const started = new Date()
  let at = started
  const fetcher: typeof fetch = async (input, options) => {
    const response = await remote.fetcher(input, options)
    at = new Date(started.getTime() + 91_000)
    return response
  }
  await expect(preflightIntervalsPace(ownerA, { fetcher, now: () => at })).rejects.toMatchObject({
    code: 'CONNECTION_CHANGED',
  })
  expect(remote.fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
})

it('patches only a missing threshold and preserves existing custom zones', async () => {
  const remote = provider({ ...valid, threshold_pace: null })
  await preflightIntervalsPace(ownerA, remote)
  const put = remote.fetcher.mock.calls.find(([, init]) => init?.method === 'PUT')
  expect(JSON.parse(String(put?.[1]?.body))).toEqual({ threshold_pace: 1000 / 300 })
  expect(remote.settings.get('owner-a')).toMatchObject({
    pace_zones: valid.pace_zones,
    pace_zone_names: valid.pace_zone_names,
  })
})

it('patches missing zones without overwriting an existing threshold', async () => {
  const remote = provider({ ...valid, pace_zones: null, pace_zone_names: null })
  const result = await preflightIntervalsPace(ownerA, remote)
  expect(result.summary.source).toBe('existing-user-configuration')
  const put = remote.fetcher.mock.calls.find(([, init]) => init?.method === 'PUT')
  expect(JSON.parse(String(put?.[1]?.body))).not.toHaveProperty('threshold_pace')
})

it('detects a changed provider configuration before writing a stale patch', async () => {
  const remote = provider({ id: 123, types: ['Run'] })
  remote.fetcher.mockResolvedValueOnce(Response.json([{ id: 123, types: ['Run'] }]))
  remote.fetcher.mockResolvedValueOnce(Response.json([valid]))
  await expect(preflightIntervalsPace(ownerA, remote)).rejects.toMatchObject({
    code: 'CONFIGURATION_CHANGED',
  })
  expect(remote.fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
})

it('does not overwrite orphaned custom zone names', async () => {
  const remote = provider({ id: 123, types: ['Run'], pace_zone_names: ['Custom'] })
  await expect(preflightIntervalsPace(ownerA, remote)).rejects.toMatchObject({
    code: 'CONFIGURATION_CONFLICT',
  })
  expect(remote.fetcher).toHaveBeenCalledOnce()
})

it('rejects ineffective readback and persists FAILED instead of READY', async () => {
  const missing = { id: 123, types: ['Run'] }
  const fetcher = vi.fn<typeof fetch>(async () => Response.json([missing]))
  await expect(preflightIntervalsPace(ownerA, { fetcher })).rejects.toMatchObject({
    code: 'READBACK_FAILED',
  })
  expect((await getIntervalsPaceStatus(ownerA)).status).toBe('FAILED')
})

it('reconciles a timeout after a provider write without sending the patch twice', async () => {
  const remote = provider({ id: 123, types: ['Run'] })
  const fetcher: typeof fetch = async (input, options) => {
    const response = await remote.fetcher(input, options)
    if (options?.method === 'PUT') throw new Error('Ambiguous timeout containing private response')
    return response
  }
  await expect(preflightIntervalsPace(ownerA, { fetcher })).rejects.toMatchObject({
    code: 'PROVIDER_UNAVAILABLE',
  })
  const result = await preflightIntervalsPace(ownerA, remote)
  expect(result.summary.source).toBe('technical-delivery-reference')
  expect(remote.fetcher.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(
    1,
  )
})

it('blocks a simultaneous preflight and releases the lease after completion', async () => {
  const remote = provider()
  let release = () => {}
  let started = () => {}
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = preflightIntervalsPace(ownerA, {
    fetcher: async (input, init) => {
      started()
      await pending
      return remote.fetcher(input, init)
    },
  })
  await entered
  await expect(preflightIntervalsPace(ownerA, remote)).rejects.toMatchObject({ code: 'BUSY' })
  release()
  await first
  await expect(preflightIntervalsPace(ownerA, remote)).resolves.toHaveProperty(
    'summary.status',
    'READY',
  )
})

it.each(['replacement', 'disconnect'])(
  'fails closed after credential %s during the provider read',
  async (action) => {
    const remote = provider({ id: 123, types: ['Run'] })
    const fetcher: typeof fetch = async () => {
      if (action === 'disconnect') credentials.delete('owner-a')
      else
        credentials.set('owner-a', {
          key: 'synthetic-new-account',
          nonce: new Uint8Array([9]),
          connectionId: 'connection-a',
        })
      cursors.clear()
      return Response.json([{ id: 123, types: ['Run'] }])
    }
    await expect(preflightIntervalsPace(ownerA, { fetcher })).rejects.toMatchObject({
      code: 'CONNECTION_CHANGED',
    })
    expect(remote.fetcher).not.toHaveBeenCalled()
    expect(cursors.size).toBe(0)
  },
)

describe('safe provider failures', () => {
  it.each([
    [401, 'INVALID_KEY'],
    [403, 'PERMISSION_REQUIRED'],
    [429, 'RATE_LIMITED'],
    [503, 'PROVIDER_UNAVAILABLE'],
  ])('blocks publication on HTTP %s', async (status, code) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('private account data', { status: Number(status) }))
    await expect(preflightIntervalsPace(ownerA, { fetcher })).rejects.toMatchObject({ code })
    expect((await getIntervalsPaceStatus(ownerA)).status).toBe('FAILED')
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
