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
import {
  disconnectProvider,
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
const idFor = (userId: string, provider: string) => `${userId}:${provider}`
const connectionFor = (where: { userId_provider: { userId: string; provider: string } }) =>
  connections.get(idFor(where.userId_provider.userId, where.userId_provider.provider)) ?? null

const prisma = {
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
        return { count: 1 }
      },
    ),
  },
  integrationCredential: {
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
  },
  syncRun: {
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
  garminImportRateLimit: {
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
  $transaction: vi.fn(async (operation: (tx: typeof prisma) => Promise<void>) => operation(prisma)),
}

const ownerA = () => getOwnerContext({ id: 'owner-a', role: 'USER', email: null })
const ownerB = () => getOwnerContext({ id: 'owner-b', role: 'ADMIN', email: null })
const fakeKey = 'synthetic-provider-api-key'

beforeEach(() => {
  vi.clearAllMocks()
  connections.clear()
  credentials.clear()
  getPrismaClient.mockResolvedValue(prisma)
  process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1'
  process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = Buffer.alloc(32, 21).toString('base64')
})

describe('owner-scoped provider vault', () => {
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
    await saveProviderApiKey(a, 'GARMIN', fakeKey)
    const original = await readProviderApiKeySnapshot(a, 'GARMIN')
    expect((await getProviderConnectionStatus(a, 'GARMIN')).status).toBe('KEY_SAVED')
    await recordProviderApiKeyAccess(b, 'GARMIN', original.nonce, 'REJECTED')
    expect((await getProviderConnectionStatus(a, 'GARMIN')).status).toBe('KEY_SAVED')
    await recordProviderApiKeyAccess(a, 'GARMIN', original.nonce, 'VERIFIED')
    expect((await getProviderConnectionStatus(a, 'GARMIN')).status).toBe('CONNECTED')

    await saveProviderApiKey(a, 'GARMIN', 'replacement-garmin-key')
    const replacement = await readProviderApiKeySnapshot(a, 'GARMIN')
    expect((await getProviderConnectionStatus(a, 'GARMIN')).status).toBe('KEY_SAVED')
    await recordProviderApiKeyAccess(a, 'GARMIN', original.nonce, 'REJECTED')
    expect((await getProviderConnectionStatus(a, 'GARMIN')).status).toBe('KEY_SAVED')
    await recordProviderApiKeyAccess(a, 'GARMIN', replacement.nonce, 'REJECTED')
    expect((await getProviderConnectionStatus(a, 'GARMIN')).status).toBe('ERROR')
    await expect(readProviderApiKey(a, 'GARMIN')).rejects.toBeInstanceOf(CredentialUnavailableError)
  })
})
