import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'

const { isVerifiedCurrentUser } = vi.hoisted(() => ({ isVerifiedCurrentUser: vi.fn(() => true) }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser }))

import {
  getOwnerContext,
  OwnedResourceNotFoundError,
  requireOwnedConnection,
} from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import {
  disconnectProvider,
  getProviderConnectionStatus,
  readProviderApiKey,
  saveProviderApiKey,
} from './vault'
import { CredentialUnavailableError } from './credential-crypto'

const requested = process.env.npm_lifecycle_event === 'test:db'
if (requested) config()
const enabled =
  requested &&
  (process.env.APP_DATABASE_ENV === 'test' || process.env.APP_DATABASE_ENV === 'development') &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.DIRECT_URL) &&
  !process.env.VERCEL_ENV
if (requested && !enabled) throw new Error('test:db requires an isolated development/test database')

describe.skipIf(!enabled)('provider vault on isolated PostgreSQL', () => {
  let prisma: PrismaClient
  const prefix = `run-21-${randomUUID()}`
  const oldVersion = process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION
  const oldKey = process.env.CREDENTIAL_ENCRYPTION_KEY_V1

  beforeAll(async () => {
    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1'
    process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = Buffer.alloc(32, 41).toString('base64')
    prisma = await getPrismaClient()
  })
  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({ where: { authSubject: { startsWith: prefix } } })
      await prisma.$disconnect()
    }
    if (oldVersion === undefined) delete process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION
    else process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = oldVersion
    if (oldKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY_V1
    else process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = oldKey
  })

  it('enforces unique ownership, encryption, replacement and local removal', async () => {
    const a = await prisma.user.create({ data: { authSubject: `${prefix}-a` } })
    const b = await prisma.user.create({ data: { authSubject: `${prefix}-b`, role: 'ADMIN' } })
    const ownerA = getOwnerContext({ id: a.id, role: 'USER', email: null })
    const ownerB = getOwnerContext({ id: b.id, role: 'ADMIN', email: null })
    const fakeKey = 'synthetic-key-database-test'

    delete process.env.CREDENTIAL_ENCRYPTION_KEY_V1
    await expect(saveProviderApiKey(ownerA, 'OPENAI', fakeKey)).rejects.toBeInstanceOf(
      CredentialUnavailableError,
    )
    expect(await prisma.integrationConnection.count({ where: { userId: a.id } })).toBe(0)
    process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = Buffer.alloc(32, 41).toString('base64')

    await saveProviderApiKey(ownerA, 'OPENAI', fakeKey)
    const connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { userId_provider: { userId: a.id, provider: 'OPENAI' } },
      include: { credential: true },
    })
    expect(connection.credential?.userId).toBe(a.id)
    expect(Buffer.from(connection.credential!.ciphertext).toString()).not.toContain(fakeKey)
    expect(await readProviderApiKey(ownerA, 'OPENAI')).toBe(fakeKey)
    expect((await getProviderConnectionStatus(ownerB, 'OPENAI')).status).toBe('DISCONNECTED')
    await expect(readProviderApiKey(ownerB, 'OPENAI')).rejects.toBeInstanceOf(
      CredentialUnavailableError,
    )
    const uncredentialedConnection = await prisma.integrationConnection.create({
      data: { userId: a.id, provider: 'INTERVALS', authMethod: 'API_KEY' },
    })
    await expect(
      requireOwnedConnection(ownerB, uncredentialedConnection.id),
    ).rejects.toBeInstanceOf(OwnedResourceNotFoundError)
    await expect(
      prisma.integrationCredential.create({
        data: {
          userId: b.id,
          connectionId: uncredentialedConnection.id,
          ciphertext: Buffer.from([1]),
          nonce: Buffer.alloc(12),
          authTag: Buffer.alloc(16),
          encryptionKeyVersion: 1,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' })
    expect(await prisma.integrationCredential.count({ where: { userId: b.id } })).toBe(0)
    expect(
      await prisma.integrationCredential.count({
        where: { connectionId: uncredentialedConnection.id },
      }),
    ).toBe(0)
    expect(await readProviderApiKey(ownerA, 'OPENAI')).toBe(fakeKey)

    await saveProviderApiKey(ownerA, 'OPENAI', 'replacement-database-test')
    expect(
      await prisma.integrationConnection.count({ where: { userId: a.id, provider: 'OPENAI' } }),
    ).toBe(1)
    expect(await readProviderApiKey(ownerA, 'OPENAI')).toBe('replacement-database-test')
    await disconnectProvider(ownerB, 'OPENAI')
    expect(await readProviderApiKey(ownerA, 'OPENAI')).toBe('replacement-database-test')
    await disconnectProvider(ownerA, 'OPENAI')
    expect(await prisma.integrationCredential.count({ where: { userId: a.id } })).toBe(0)
    await expect(readProviderApiKey(ownerA, 'OPENAI')).rejects.toBeInstanceOf(
      CredentialUnavailableError,
    )
  })
})
