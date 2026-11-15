import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getPrismaClient, isVerifiedCurrentUser } = vi.hoisted(() => ({
  getPrismaClient: vi.fn(),
  isVerifiedCurrentUser: vi.fn(() => true),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/server/db/client', () => ({ getPrismaClient }))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser }))

import { getOwnerContext, OwnedResourceNotFoundError } from '@/server/authorization/ownership'
import { CredentialUnavailableError } from './credential-crypto'
import { connectIntervals, testIntervalsConnection } from '@/server/intervals/connection'
import {
  disconnectProvider,
  CredentialWriteConflictError,
  getProviderConnectionStatus,
  InvalidCredentialError,
  readProviderApiKey,
  readProviderApiKeySnapshot,
  recordProviderApiKeyAccess,
  saveProviderApiKey,
} from './vault'

type Connection = {
  id: string
  userId: string
  provider: 'OPENAI' | 'INTERVALS' | 'GARMIN'
  authMethod: 'API_KEY'
  status: 'CONNECTED' | 'PENDING' | 'REVOKED' | 'ERROR'
  externalAccountId?: string | null
  lastSuccessAt?: Date | null
  lastFailureAt?: Date | null
  createdAt: Date
  updatedAt: Date
}
type Credential = {
  userId: string
  connectionId: string
  ciphertext: Uint8Array
  nonce: Uint8Array
  authTag: Uint8Array
  encryptionKeyVersion: number
  rotatedAt: Date
}

const connections = new Map<string, Connection>()
const credentials = new Map<string, Credential>()
const revisions = new Map<string, number>()
const idFor = (userId: string, provider: string) => `${userId}:${provider}`
const connectionFor = (where: { userId_provider: { userId: string; provider: string } }) =>
  connections.get(idFor(where.userId_provider.userId, where.userId_provider.provider)) ?? null

const prismaStore = {
  integrationConnection: {
    findUnique: vi.fn(async ({ where }: { where: Parameters<typeof connectionFor>[0] }) => {
      const connection = connectionFor(where)
      return connection
        ? { ...connection, credential: credentials.get(connection.id) ?? null }
        : null
    }),
    findFirst: vi.fn(
      async ({ where }: { where: { id: string; userId: string } }) =>
        [...connections.values()].find((c) => c.id === where.id && c.userId === where.userId) ??
        null,
    ),
    upsert: vi.fn(
      async ({
        where,
        create,
      }: {
        where: Parameters<typeof connectionFor>[0]
        create: Connection
      }) => {
        const existing = connectionFor(where)
        if (existing) return existing
        const connection = { ...create, createdAt: new Date(), updatedAt: new Date() }
        connections.set(idFor(connection.userId, connection.provider), connection)
        revisions.set(connection.id, 1)
        return connection
      },
    ),
    update: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { userId_id: { userId: string; id: string } }
        data: Partial<Connection>
      }) => {
        const connection = [...connections.values()].find(
          (c) => c.id === where.userId_id.id && c.userId === where.userId_id.userId,
        )
        if (!connection) throw new Error('not found')
        Object.assign(connection, data)
        connection.updatedAt = new Date()
        revisions.set(connection.id, (revisions.get(connection.id) ?? 0) + 1)
        return connection
      },
    ),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: {
          userId: string
          provider: string
          status: Connection['status']
          credential: { is: { userId: string; nonce: Uint8Array } }
        }
        data: Partial<Connection>
      }) => {
        const connection = connectionFor({ userId_provider: where })
        const credential = connection && credentials.get(connection.id)
        if (
          !connection ||
          connection.status !== where.status ||
          credential?.userId !== where.credential.is.userId ||
          !Buffer.from(credential.nonce).equals(Buffer.from(where.credential.is.nonce))
        )
          return { count: 0 }
        Object.assign(connection, data)
        connection.updatedAt = new Date()
        revisions.set(connection.id, (revisions.get(connection.id) ?? 0) + 1)
        return { count: 1 }
      },
    ),
  },
  integrationCredential: {
    findUnique: vi.fn(
      async ({ where }: { where: { connectionId: string } }) =>
        credentials.get(where.connectionId) ?? null,
    ),
    upsert: vi.fn(async ({ create, update }: { create: Credential; update: Credential }) => {
      credentials.set(
        create.connectionId,
        credentials.has(create.connectionId) ? { ...create, ...update } : create,
      )
    }),
    deleteMany: vi.fn(async ({ where }: { where: { userId: string; connectionId: string } }) => {
      const row = credentials.get(where.connectionId)
      if (row?.userId === where.userId) credentials.delete(where.connectionId)
    }),
  },
  syncCursor: {
    deleteMany: vi.fn(async () => ({ count: 0 })),
    updateMany: vi.fn(async () => ({ count: 0 })),
    findMany: vi.fn(async () => []),
  },
  syncRun: {
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
  garminImportRateLimit: {
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
  $queryRaw: vi.fn(async (_query: TemplateStringsArray, userId: string, provider: string) => {
    const connection = connections.get(idFor(userId, provider))
    return connection ? [{ id: connection.id, version: String(revisions.get(connection.id)) }] : []
  }),
}

const prisma = {
  ...prismaStore,
  $transaction: vi.fn(async <T>(operation: (tx: typeof prismaStore) => Promise<T>): Promise<T> =>
    operation(prismaStore),
  ),
}

const ownerA = () => getOwnerContext({ id: 'owner-a', role: 'USER', email: null })
const ownerB = () => getOwnerContext({ id: 'owner-b', role: 'ADMIN', email: null })
const fakeKey = 'synthetic-provider-api-key'

beforeEach(() => {
  vi.clearAllMocks()
  connections.clear()
  credentials.clear()
  revisions.clear()
  getPrismaClient.mockResolvedValue(prisma)
  process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1'
  process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = Buffer.alloc(32, 21).toString('base64')
})

describe('owner-scoped provider vault', () => {
  it.each(['initial', 'replacement', 'reconnect'])(
    'does not restore a credential after Disconnect during %s verification',
    async (scenario) => {
      const fetcher = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => Response.json([]))
      try {
        const owner = ownerA()
        if (scenario !== 'initial') await connectIntervals(owner, 'synthetic-original-key')
        if (scenario === 'reconnect') await disconnectProvider(owner, 'INTERVALS')
        fetcher.mockImplementationOnce(async () => {
          await disconnectProvider(owner, 'INTERVALS')
          return Response.json([])
        })
        await expect(connectIntervals(owner, 'synthetic-late-key')).rejects.toBeInstanceOf(
          CredentialWriteConflictError,
        )
        expect((await getProviderConnectionStatus(owner, 'INTERVALS')).status).toBe('DISCONNECTED')
        expect(credentials.size).toBe(0)
      } finally {
        fetcher.mockRestore()
      }
    },
  )

  it('does not overwrite a newer key replacement that finishes during provider verification', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json([]))
    try {
      const owner = ownerA()
      await connectIntervals(owner, 'synthetic-original-key')
      fetcher.mockImplementationOnce(async () => {
        await connectIntervals(owner, 'synthetic-newer-key')
        return Response.json([])
      })
      await expect(connectIntervals(owner, 'synthetic-stale-key')).rejects.toBeInstanceOf(
        CredentialWriteConflictError,
      )
      expect(await readProviderApiKey(owner, 'INTERVALS')).toBe('synthetic-newer-key')
    } finally {
      fetcher.mockRestore()
    }
  })

  it.each([
    new Headers({ 'cf-mitigated': 'challenge', 'content-type': 'application/json' }),
    new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    new Headers({ 'content-type': 'application/xhtml+xml' }),
  ])(
    'preserves a tested key through a Cloudflare/HTML 403 and permits the next test: %j',
    async (headers) => {
      const fetcher = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => Response.json([]))
      try {
        const owner = ownerA()
        await connectIntervals(owner, 'synthetic-working-key')
        await testIntervalsConnection(owner)
        const original = await readProviderApiKeySnapshot(owner, 'INTERVALS')
        fetcher.mockResolvedValueOnce(new Response('challenge', { status: 403, headers }))
        await expect(testIntervalsConnection(owner)).rejects.toMatchObject({
          code: 'PROVIDER_UNAVAILABLE',
        })
        expect((await getProviderConnectionStatus(owner, 'INTERVALS')).status).toBe('CONNECTED')
        expect((await readProviderApiKeySnapshot(owner, 'INTERVALS')).nonce).toEqual(original.nonce)
        expect((await testIntervalsConnection(owner)).status).toBe('CONNECTED')
      } finally {
        fetcher.mockRestore()
      }
    },
  )

  it('connects, tests, replaces and revokes two independent Intervals accounts without Garmin credentials', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json([]))
    try {
      const a = ownerA()
      const b = ownerB()
      const keyA = 'synthetic-intervals-owner-a'
      const keyB = 'synthetic-intervals-owner-b'
      expect((await connectIntervals(a, keyA)).status).toBe('KEY_SAVED')
      expect((await getProviderConnectionStatus(b, 'INTERVALS')).status).toBe('DISCONNECTED')
      await expect(testIntervalsConnection(b)).rejects.toBeInstanceOf(CredentialUnavailableError)
      expect((await connectIntervals(b, keyB)).status).toBe('KEY_SAVED')
      expect((await testIntervalsConnection(a)).status).toBe('CONNECTED')
      expect((await getProviderConnectionStatus(b, 'INTERVALS')).status).toBe('KEY_SAVED')
      expect((await testIntervalsConnection(b)).status).toBe('CONNECTED')
      expect(fetcher.mock.calls.map(([, init]) => init?.headers)).toEqual([
        {
          Authorization: `Basic ${Buffer.from(`API_KEY:${keyA}`).toString('base64')}`,
          Accept: 'application/json',
        },
        {
          Authorization: `Basic ${Buffer.from(`API_KEY:${keyB}`).toString('base64')}`,
          Accept: 'application/json',
        },
        {
          Authorization: `Basic ${Buffer.from(`API_KEY:${keyA}`).toString('base64')}`,
          Accept: 'application/json',
        },
        {
          Authorization: `Basic ${Buffer.from(`API_KEY:${keyB}`).toString('base64')}`,
          Accept: 'application/json',
        },
      ])
      const original = await readProviderApiKeySnapshot(a, 'INTERVALS')
      await connectIntervals(a, 'synthetic-replacement-key')
      await recordProviderApiKeyAccess(a, 'INTERVALS', original.nonce, 'REJECTED')
      expect((await getProviderConnectionStatus(a, 'INTERVALS')).status).toBe('KEY_SAVED')
      await recordProviderApiKeyAccess(b, 'INTERVALS', original.nonce, 'REJECTED')
      expect((await getProviderConnectionStatus(b, 'INTERVALS')).status).toBe('CONNECTED')

      fetcher.mockResolvedValueOnce(new Response('revoked', { status: 401 }))
      await expect(testIntervalsConnection(a)).rejects.toMatchObject({ code: 'INVALID_KEY' })
      expect((await getProviderConnectionStatus(a, 'INTERVALS')).status).toBe('ERROR')
      expect((await getProviderConnectionStatus(b, 'INTERVALS')).status).toBe('CONNECTED')
      await disconnectProvider(a, 'INTERVALS')
      await expect(testIntervalsConnection(a)).rejects.toBeInstanceOf(CredentialUnavailableError)
      expect(await readProviderApiKey(b, 'INTERVALS')).toBe(keyB)
      await disconnectProvider(b, 'INTERVALS')
      expect(credentials.size).toBe(0)
      expect([...connections.values()].every((row) => row.provider === 'INTERVALS')).toBe(true)
      expect(
        fetcher.mock.calls.every(
          ([url, init]) => String(url).includes('/athlete/0/events?') && init?.method === 'GET',
        ),
      ).toBe(true)
    } finally {
      fetcher.mockRestore()
    }
  })

  it('retains the existing Intervals key on failed replacement and transient test failures', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json([]))
    try {
      const a = ownerA()
      await connectIntervals(a, 'synthetic-original-intervals-key')
      await testIntervalsConnection(a)
      const original = await readProviderApiKeySnapshot(a, 'INTERVALS')
      fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }))
      await expect(connectIntervals(a, 'synthetic-bad-replacement')).rejects.toMatchObject({
        code: 'INVALID_KEY',
      })
      expect((await readProviderApiKeySnapshot(a, 'INTERVALS')).nonce).toEqual(original.nonce)
      for (const status of [429, 500]) {
        fetcher.mockResolvedValueOnce(new Response(null, { status }))
        await expect(testIntervalsConnection(a)).rejects.toThrow()
        expect((await getProviderConnectionStatus(a, 'INTERVALS')).status).toBe('CONNECTED')
      }
      fetcher.mockImplementationOnce(async () => {
        await disconnectProvider(a, 'INTERVALS')
        return Response.json([])
      })
      expect((await testIntervalsConnection(a)).status).toBe('DISCONNECTED')
      await expect(readProviderApiKey(a, 'INTERVALS')).rejects.toBeInstanceOf(
        CredentialUnavailableError,
      )
    } finally {
      fetcher.mockRestore()
    }
  })

  it('saves encrypted keys, replaces them and separates OpenAI from Intervals', async () => {
    const a = ownerA()
    expect(await getProviderConnectionStatus(a, 'OPENAI')).toMatchObject({ status: 'DISCONNECTED' })
    await saveProviderApiKey(a, 'OPENAI', fakeKey)
    const row = [...credentials.values()][0]
    expect(Buffer.from(row.ciphertext).toString()).not.toContain(fakeKey)
    expect(JSON.stringify(await getProviderConnectionStatus(a, 'OPENAI'))).not.toContain(fakeKey)
    expect(await readProviderApiKey(a, 'OPENAI')).toBe(fakeKey)
    await saveProviderApiKey(a, 'OPENAI', 'replacement-test-key')
    expect(connections.size).toBe(1)
    expect(await readProviderApiKey(a, 'OPENAI')).toBe('replacement-test-key')
    await saveProviderApiKey(a, 'INTERVALS', 'intervals-test-key')
    expect(await readProviderApiKey(a, 'INTERVALS')).toBe('intervals-test-key')
  })

  it('never reads, replaces or removes another owner’s credential, even for ADMIN', async () => {
    const a = ownerA()
    const b = ownerB()
    await saveProviderApiKey(a, 'OPENAI', fakeKey)
    expect(await getProviderConnectionStatus(b, 'OPENAI')).toMatchObject({ status: 'DISCONNECTED' })
    await expect(readProviderApiKey(b, 'OPENAI')).rejects.toBeInstanceOf(CredentialUnavailableError)
    // A forged/incorrect existing connection ID is checked before the write.
    const otherConnection = connections.get('owner-a:OPENAI')!
    prisma.integrationConnection.findUnique.mockResolvedValueOnce({
      ...otherConnection,
      credential: credentials.get(otherConnection.id)!,
    })
    await expect(saveProviderApiKey(b, 'OPENAI', 'other-test-key')).rejects.toBeInstanceOf(
      OwnedResourceNotFoundError,
    )
    expect(await readProviderApiKey(a, 'OPENAI')).toBe(fakeKey)
    await disconnectProvider(b, 'OPENAI')
    expect(await readProviderApiKey(a, 'OPENAI')).toBe(fakeKey)
  })

  it('disconnects locally and prevents later reads; missing keys fail closed', async () => {
    const a = ownerA()
    await expect(saveProviderApiKey(a, 'OPENAI', 'bad key with spaces')).rejects.toBeInstanceOf(
      InvalidCredentialError,
    )
    expect(connections.size).toBe(0)
    await expect(readProviderApiKey(a, 'OPENAI')).rejects.toBeInstanceOf(CredentialUnavailableError)
    await saveProviderApiKey(a, 'OPENAI', fakeKey)
    await disconnectProvider(a, 'OPENAI')
    expect(credentials.size).toBe(0)
    expect(await getProviderConnectionStatus(a, 'OPENAI')).toMatchObject({ status: 'DISCONNECTED' })
    await expect(readProviderApiKey(a, 'OPENAI')).rejects.toBeInstanceOf(CredentialUnavailableError)
  })

  it('updates only the owner and exact saved Garmin key after API verification or rejection', async () => {
    const a = ownerA()
    const b = ownerB()
    await saveProviderApiKey(a, 'GARMIN', fakeKey, { verifiedGarminAccountId: '123456' })
    const original = await readProviderApiKeySnapshot(a, 'GARMIN')
    expect((await getProviderConnectionStatus(a, 'GARMIN')).status).toBe('KEY_SAVED')
    await recordProviderApiKeyAccess(b, 'GARMIN', original.nonce, 'REJECTED')
    expect((await getProviderConnectionStatus(a, 'GARMIN')).status).toBe('KEY_SAVED')
    await recordProviderApiKeyAccess(a, 'GARMIN', original.nonce, 'VERIFIED')
    expect((await getProviderConnectionStatus(a, 'GARMIN')).status).toBe('CONNECTED')

    await saveProviderApiKey(a, 'GARMIN', 'replacement-garmin-key', {
      verifiedGarminAccountId: '123456',
    })
    const replacement = await readProviderApiKeySnapshot(a, 'GARMIN')
    expect((await getProviderConnectionStatus(a, 'GARMIN')).status).toBe('KEY_SAVED')
    await recordProviderApiKeyAccess(a, 'GARMIN', original.nonce, 'REJECTED')
    expect((await getProviderConnectionStatus(a, 'GARMIN')).status).toBe('KEY_SAVED')
    await recordProviderApiKeyAccess(a, 'GARMIN', replacement.nonce, 'REJECTED')
    expect((await getProviderConnectionStatus(a, 'GARMIN')).status).toBe('ERROR')
    await expect(readProviderApiKey(a, 'GARMIN')).rejects.toBeInstanceOf(CredentialUnavailableError)
  })

  it('identifies a saved legacy key and binds only the exact credential that was verified', async () => {
    const a = ownerA()
    await saveProviderApiKey(a, 'GARMIN', fakeKey, { verifiedGarminAccountId: '123456' })
    const connection = connections.get('owner-a:GARMIN')!
    connection.externalAccountId = null
    expect((await getProviderConnectionStatus(a, 'GARMIN')).status).toBe('VERIFICATION_REQUIRED')
    const saved = await readProviderApiKeySnapshot(a, 'GARMIN')
    await expect(
      saveProviderApiKey(a, 'GARMIN', saved.key, {
        verifiedGarminAccountId: '123456',
        expectedCredentialNonce: new Uint8Array([9]),
      }),
    ).rejects.toBeInstanceOf(CredentialUnavailableError)
    expect((await readProviderApiKeySnapshot(a, 'GARMIN')).accountId).toBeNull()
    await saveProviderApiKey(a, 'GARMIN', saved.key, {
      verifiedGarminAccountId: '123456',
      expectedCredentialNonce: saved.nonce,
    })
    expect((await getProviderConnectionStatus(a, 'GARMIN')).status).toBe('KEY_SAVED')
    expect((await readProviderApiKeySnapshot(a, 'GARMIN')).accountId).toBe('123456')
  })
})
