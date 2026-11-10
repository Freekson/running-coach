import { testGarminAccountId } from '@/server/garmin/test-identity'
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
  deleteAllImportedGarminData,
  disconnectProvider,
  GarminAccountMismatchError,
  getProviderConnectionStatus,
  readProviderApiKey,
  readProviderApiKeySnapshot,
  recordProviderApiKeyAccess,
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

  it('re-verifies a legacy saved key with a nonce guard before enabling imports', async () => {
    const user = await prisma.user.create({ data: { authSubject: `${prefix}-legacy-key` } })
    const owner = getOwnerContext({ id: user.id, role: 'USER', email: null })
    const accountId = testGarminAccountId(owner)
    const key = 'synthetic-legacy-saved-key'
    await saveProviderApiKey(owner, 'GARMIN', key, { verifiedGarminAccountId: accountId })
    const snapshot = await readProviderApiKeySnapshot(owner, 'GARMIN')
    await prisma.integrationConnection.update({
      where: { userId_provider: { userId: user.id, provider: 'GARMIN' } },
      data: { externalAccountId: null },
    })
    expect((await getProviderConnectionStatus(owner, 'GARMIN')).status).toBe(
      'VERIFICATION_REQUIRED',
    )
    await expect(
      saveProviderApiKey(owner, 'GARMIN', key, {
        verifiedGarminAccountId: accountId,
        expectedCredentialNonce: new Uint8Array([9]),
      }),
    ).rejects.toBeInstanceOf(CredentialUnavailableError)
    expect((await readProviderApiKeySnapshot(owner, 'GARMIN')).accountId).toBeNull()
    await saveProviderApiKey(owner, 'GARMIN', key, {
      verifiedGarminAccountId: accountId,
      expectedCredentialNonce: snapshot.nonce,
    })
    expect((await getProviderConnectionStatus(owner, 'GARMIN')).status).toBe('KEY_SAVED')
    expect((await readProviderApiKeySnapshot(owner, 'GARMIN')).accountId).toBe(accountId)
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
    await saveProviderApiKey(ownerA, 'GARMIN', 'synthetic-garmin-key-database-test', {
      verifiedGarminAccountId: testGarminAccountId(ownerA),
    })
    expect((await getProviderConnectionStatus(ownerA, 'GARMIN')).status).toBe('KEY_SAVED')
    expect(await readProviderApiKey(ownerA, 'GARMIN')).toBe('synthetic-garmin-key-database-test')
    await expect(readProviderApiKey(ownerB, 'GARMIN')).rejects.toBeInstanceOf(
      CredentialUnavailableError,
    )
    const originalGarmin = await readProviderApiKeySnapshot(ownerA, 'GARMIN')
    await recordProviderApiKeyAccess(ownerB, 'GARMIN', originalGarmin.nonce, 'REJECTED')
    expect((await getProviderConnectionStatus(ownerA, 'GARMIN')).status).toBe('KEY_SAVED')
    await recordProviderApiKeyAccess(ownerA, 'GARMIN', originalGarmin.nonce, 'VERIFIED')
    expect((await getProviderConnectionStatus(ownerA, 'GARMIN')).status).toBe('CONNECTED')
    await saveProviderApiKey(ownerA, 'GARMIN', 'replacement-garmin-database-key', {
      verifiedGarminAccountId: testGarminAccountId(ownerA),
    })
    const replacementGarmin = await readProviderApiKeySnapshot(ownerA, 'GARMIN')
    await recordProviderApiKeyAccess(ownerA, 'GARMIN', originalGarmin.nonce, 'REJECTED')
    expect((await getProviderConnectionStatus(ownerA, 'GARMIN')).status).toBe('KEY_SAVED')
    await recordProviderApiKeyAccess(ownerA, 'GARMIN', replacementGarmin.nonce, 'REJECTED')
    expect((await getProviderConnectionStatus(ownerA, 'GARMIN')).status).toBe('ERROR')
    await expect(readProviderApiKey(ownerA, 'GARMIN')).rejects.toBeInstanceOf(
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
    await disconnectProvider(ownerA, 'GARMIN')
    expect(await prisma.integrationCredential.count({ where: { userId: a.id } })).toBe(0)
    await expect(readProviderApiKey(ownerA, 'OPENAI')).rejects.toBeInstanceOf(
      CredentialUnavailableError,
    )
    await expect(readProviderApiKey(ownerA, 'GARMIN')).rejects.toBeInstanceOf(
      CredentialUnavailableError,
    )
  })

  it('keeps one verified account per user, preserves history on disconnect, and deletes only Garmin imports on reset', async () => {
    const a = await prisma.user.create({ data: { authSubject: `${prefix}-policy-a` } })
    const b = await prisma.user.create({ data: { authSubject: `${prefix}-policy-b` } })
    const ownerA = getOwnerContext({ id: a.id, role: 'USER', email: null })
    const ownerB = getOwnerContext({ id: b.id, role: 'USER', email: null })
    const accountId = testGarminAccountId(ownerA)
    const anotherId = testGarminAccountId(ownerB)
    await saveProviderApiKey(ownerA, 'GARMIN', 'synthetic-first-policy-key', {
      verifiedGarminAccountId: accountId,
    })
    const first = await readProviderApiKeySnapshot(ownerA, 'GARMIN')
    await expect(
      saveProviderApiKey(ownerA, 'GARMIN', 'synthetic-wrong-policy-key', {
        verifiedGarminAccountId: anotherId,
      }),
    ).rejects.toBeInstanceOf(GarminAccountMismatchError)
    expect((await readProviderApiKeySnapshot(ownerA, 'GARMIN')).key).toBe(
      'synthetic-first-policy-key',
    )
    await expect(
      saveProviderApiKey(ownerB, 'GARMIN', 'synthetic-cross-owner-key', {
        verifiedGarminAccountId: accountId,
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_ALREADY_LINKED' })
    const initialConnection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { userId_provider: { userId: a.id, provider: 'GARMIN' } },
    })
    await prisma.syncCursor.create({
      data: {
        userId: a.id,
        connectionId: initialConnection.id,
        dataType: 'ACTIVITIES',
        cursorOrCheckpoint: { version: 1, actionRequired: true, nextDate: '2026-11-07' },
      },
    })
    const retryAt = new Date(Date.now() + 60_000)
    await prisma.garminImportRateLimit.create({
      data: { userId: a.id, count: 1, windowStartedAt: new Date(), providerRetryAt: retryAt },
    })
    await saveProviderApiKey(ownerA, 'GARMIN', 'synthetic-rotated-policy-key', {
      verifiedGarminAccountId: accountId,
    })
    expect(
      (await prisma.garminImportRateLimit.findUniqueOrThrow({ where: { userId: a.id } }))
        .providerRetryAt,
    ).toEqual(retryAt)
    expect(
      (
        await prisma.syncCursor.findUniqueOrThrow({
          where: {
            connectionId_dataType: { connectionId: initialConnection.id, dataType: 'ACTIVITIES' },
          },
        })
      ).cursorOrCheckpoint,
    ).toMatchObject({ actionRequired: false, nextDate: '2026-11-07' })
    const rotated = await readProviderApiKeySnapshot(ownerA, 'GARMIN')
    expect(rotated.accountId).toBe(accountId)
    expect(rotated.nonce).not.toEqual(first.nonce)
    const garmin = await prisma.activity.create({
      data: {
        userId: a.id,
        sourceProvider: 'GARMIN',
        garminAccountId: accountId,
        externalActivityId: 'policy-activity',
        sportType: 'RUNNING',
        startedAt: new Date('2026-11-07T07:00:00Z'),
        listStartedAt: new Date('2026-11-07T07:00:00Z'),
      },
    })
    await prisma.activityLap.create({
      data: { userId: a.id, activityId: garmin.id, lapIndex: 0, sourceRecordType: 'FIT_LAP' },
    })
    await prisma.activity.create({
      data: {
        userId: a.id,
        sourceProvider: 'INTERVALS',
        externalActivityId: 'unrelated',
        sportType: 'RUNNING',
        startedAt: new Date('2026-11-07T08:00:00Z'),
        listStartedAt: new Date('2026-11-07T08:00:00Z'),
      },
    })
    await prisma.dailyHealthMetric.create({
      data: {
        userId: a.id,
        sourceProvider: 'GARMIN',
        garminAccountId: accountId,
        localDate: new Date('2026-11-07T00:00:00Z'),
        sourceTimezone: 'UTC',
        restingHrBpm: 50,
        summaryFetchedAt: new Date('2026-11-08T00:00:00Z'),
      },
    })
    const connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { userId_provider: { userId: a.id, provider: 'GARMIN' } },
    })
    await prisma.syncCursor.create({
      data: {
        userId: a.id,
        connectionId: connection.id,
        dataType: 'HEALTH',
        cursorOrCheckpoint: { nextDate: '2026-11-08' },
      },
    })
    await prisma.syncRun.create({
      data: { userId: a.id, connectionId: connection.id, jobType: 'HEALTH' },
    })
    await disconnectProvider(ownerA, 'GARMIN')
    expect(await prisma.activity.count({ where: { userId: a.id, sourceProvider: 'GARMIN' } })).toBe(
      1,
    )
    expect(await prisma.dailyHealthMetric.count({ where: { userId: a.id } })).toBe(1)
    await expect(
      saveProviderApiKey(ownerA, 'GARMIN', 'synthetic-wrong-reconnect-key', {
        verifiedGarminAccountId: anotherId,
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' })
    await saveProviderApiKey(ownerA, 'GARMIN', 'synthetic-reconnected-key', {
      verifiedGarminAccountId: accountId,
    })
    await deleteAllImportedGarminData(ownerB)
    expect((await readProviderApiKeySnapshot(ownerA, 'GARMIN')).accountId).toBe(accountId)
    await deleteAllImportedGarminData(ownerA)
    expect(await prisma.activity.count({ where: { userId: a.id, sourceProvider: 'GARMIN' } })).toBe(
      0,
    )
    expect(await prisma.activityLap.count({ where: { userId: a.id } })).toBe(0)
    expect(
      await prisma.dailyHealthMetric.count({ where: { userId: a.id, sourceProvider: 'GARMIN' } }),
    ).toBe(0)
    expect(await prisma.syncRun.count({ where: { userId: a.id } })).toBe(0)
    expect(await prisma.syncCursor.count({ where: { userId: a.id } })).toBe(0)
    expect(await prisma.garminImportRateLimit.count({ where: { userId: a.id } })).toBe(0)
    expect(
      await prisma.activity.count({ where: { userId: a.id, sourceProvider: 'INTERVALS' } }),
    ).toBe(1)
    await saveProviderApiKey(ownerA, 'GARMIN', 'synthetic-another-account-key', {
      verifiedGarminAccountId: anotherId,
    })
    expect((await readProviderApiKeySnapshot(ownerA, 'GARMIN')).accountId).toBe(anotherId)
  })
})
