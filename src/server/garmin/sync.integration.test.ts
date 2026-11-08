import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'

vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))

import { getOwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import { saveProviderApiKey } from '@/server/provider/vault'
import { readProviderApiKeySnapshot } from '@/server/provider/vault'
import { allowGarminImport, pauseGarminProviderUntil } from './import-rate-limit'
import { GarminImportError } from './activity-import'
import { getGarminSyncState, runGarminSync } from './sync'
import { findScheduledGarminOwnerId } from './scheduled-sync'

const requested = process.env.npm_lifecycle_event === 'test:db'
if (requested) config()
const enabled =
  requested &&
  (process.env.APP_DATABASE_ENV === 'test' || process.env.APP_DATABASE_ENV === 'development') &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.DIRECT_URL) &&
  !process.env.VERCEL_ENV
if (requested && !enabled)
  throw new Error('test:db requires isolated development/test database URLs')

describe.skipIf(!enabled)('Garmin sync lease and checkpoint on isolated PostgreSQL', () => {
  let prisma: PrismaClient
  let owner: ReturnType<typeof getOwnerContext>
  let other: ReturnType<typeof getOwnerContext>
  const prefix = `run26-sync-${randomUUID()}`

  beforeAll(async () => {
    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1'
    process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = Buffer.alloc(32, 31).toString('base64')
    prisma = await getPrismaClient()
    const a = await prisma.user.create({ data: { authSubject: `${prefix}-a` } })
    const b = await prisma.user.create({ data: { authSubject: `${prefix}-b`, role: 'ADMIN' } })
    owner = getOwnerContext({ id: a.id, role: 'USER', email: null })
    other = getOwnerContext({ id: b.id, role: 'ADMIN', email: null })
    await saveProviderApiKey(owner, 'GARMIN', 'synthetic-garmin-key')
  })

  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({ where: { authSubject: { startsWith: prefix } } })
      await prisma.$disconnect()
    }
    delete process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_V1
  })

  it('claims one lease, commits a page, and resumes without exposing another user', async () => {
    let clock = new Date()
    let release!: (value: {
      imported: [{ id: string; lapImportStatus: 'IMPORTED' }]
      providerIds: string[]
      hasMore: true
      nextStart: 1
    }) => void
    const importPage = vi.fn(
      () =>
        new Promise<{
          imported: [{ id: string; lapImportStatus: 'IMPORTED' }]
          providerIds: string[]
          hasMore: true
          nextStart: 1
        }>((resolve) => {
          release = resolve
        }),
    )
    const running = runGarminSync(owner, {}, { now: () => clock, importPage })
    await vi.waitFor(() => expect(importPage).toHaveBeenCalledOnce())
    await expect(runGarminSync(owner, {}, { now: () => clock, importPage })).rejects.toMatchObject({
      code: 'BUSY',
    })
    expect((await getGarminSyncState(other)).status).toBe('NOT_CONNECTED')
    clock = new Date(clock.getTime() + 21_000)
    release({
      imported: [{ id: 'synthetic-activity', lapImportStatus: 'IMPORTED' }],
      providerIds: ['123'],
      hasMore: true,
      nextStart: 1,
    })
    await running
    const connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { userId_provider: { userId: owner.userId, provider: 'GARMIN' } },
    })
    const cursor = await prisma.syncCursor.findUniqueOrThrow({
      where: { connectionId_dataType: { connectionId: connection.id, dataType: 'ACTIVITIES' } },
    })
    expect(cursor.cursorOrCheckpoint).toMatchObject({ offset: 1 })
    const resumed = vi.fn(async () => {
      clock = new Date(clock.getTime() + 21_000)
      return { imported: [], providerIds: [], hasMore: false, nextStart: null }
    })
    await runGarminSync(owner, {}, { now: () => clock, importPage: resumed })
    expect(resumed.mock.calls).toHaveLength(1)
    expect(
      (
        await prisma.syncCursor.findUniqueOrThrow({
          where: { connectionId_dataType: { connectionId: connection.id, dataType: 'ACTIVITIES' } },
        })
      ).cursorOrCheckpoint,
    ).toMatchObject({ offset: 0 })
  })

  it('rotates scheduled connections by last attempt, including a never-synced owner', async () => {
    const third = await prisma.user.create({ data: { authSubject: `${prefix}-c` } })
    const thirdOwner = getOwnerContext({ id: third.id, role: 'USER', email: null })
    await saveProviderApiKey(thirdOwner, 'GARMIN', 'synthetic-third-garmin-key')
    const candidates = [owner.userId, third.id]
    const first = await findScheduledGarminOwnerId(new Date(), candidates)
    expect(candidates).toContain(first)
    const firstConnection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { userId_provider: { userId: first!, provider: 'GARMIN' } },
    })
    await prisma.syncRun.create({
      data: {
        userId: first!,
        connectionId: firstConnection.id,
        jobType: 'GARMIN_ACTIVITIES',
        status: 'FAILED',
        startedAt: new Date('2030-01-01T00:00:00Z'),
        errorCode: 'UNAVAILABLE',
      },
    })
    const second = await findScheduledGarminOwnerId(new Date(), candidates)
    expect(second).toBe(candidates.find((id) => id !== first))
  })

  it('records and pauses an invalid checkpoint so another owner can be scheduled', async () => {
    const brokenUser = await prisma.user.create({ data: { authSubject: `${prefix}-broken` } })
    const healthyUser = await prisma.user.create({ data: { authSubject: `${prefix}-healthy` } })
    const brokenOwner = getOwnerContext({ id: brokenUser.id, role: 'USER', email: null })
    const healthyOwner = getOwnerContext({ id: healthyUser.id, role: 'USER', email: null })
    await saveProviderApiKey(brokenOwner, 'GARMIN', 'synthetic-broken-user-key')
    await saveProviderApiKey(healthyOwner, 'GARMIN', 'synthetic-healthy-user-key')
    const connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { userId_provider: { userId: brokenUser.id, provider: 'GARMIN' } },
    })
    await prisma.syncCursor.create({
      data: {
        userId: brokenUser.id,
        connectionId: connection.id,
        dataType: 'ACTIVITIES',
        cursorOrCheckpoint: { version: 999 },
      },
    })
    await expect(runGarminSync(brokenOwner)).rejects.toThrow('Invalid saved Garmin checkpoint')
    const run = await prisma.syncRun.findFirstOrThrow({
      where: { userId: brokenUser.id, connectionId: connection.id },
      orderBy: { startedAt: 'desc' },
    })
    expect(run.status).toBe('FAILED')
    expect(run.errorCode).toBe('INVALID_CHECKPOINT')
    const cursor = await prisma.syncCursor.findUniqueOrThrow({
      where: { connectionId_dataType: { connectionId: connection.id, dataType: 'ACTIVITIES' } },
    })
    expect(cursor.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now())
    expect(await findScheduledGarminOwnerId(new Date(), [brokenUser.id, healthyUser.id])).toBe(
      healthyUser.id,
    )
  })

  it('skips a provider-paused owner when scheduling', async () => {
    const pausedUser = await prisma.user.create({ data: { authSubject: `${prefix}-paused` } })
    const readyUser = await prisma.user.create({ data: { authSubject: `${prefix}-ready` } })
    const pausedOwner = getOwnerContext({ id: pausedUser.id, role: 'USER', email: null })
    const readyOwner = getOwnerContext({ id: readyUser.id, role: 'USER', email: null })
    await saveProviderApiKey(pausedOwner, 'GARMIN', 'synthetic-paused-user-key')
    await saveProviderApiKey(readyOwner, 'GARMIN', 'synthetic-ready-user-key')
    const credential = await readProviderApiKeySnapshot(pausedOwner, 'GARMIN')
    const retryAt = new Date(Date.now() + 60_000)
    await pauseGarminProviderUntil(pausedOwner, retryAt, credential.nonce)

    expect(await findScheduledGarminOwnerId(new Date(), [pausedUser.id, readyUser.id])).toBe(
      readyUser.id,
    )
    expect((await getGarminSyncState(pausedOwner)).status).toBe('PAUSED')
    await expect(runGarminSync(pausedOwner)).rejects.toMatchObject({ code: 'PAUSED' })
  })

  it('skips an action-required owner and schedules another owner after access is denied', async () => {
    const deniedUser = await prisma.user.create({ data: { authSubject: `${prefix}-denied` } })
    const readyUser = await prisma.user.create({ data: { authSubject: `${prefix}-after-denial` } })
    const deniedOwner = getOwnerContext({ id: deniedUser.id, role: 'USER', email: null })
    const readyOwner = getOwnerContext({ id: readyUser.id, role: 'USER', email: null })
    await saveProviderApiKey(deniedOwner, 'GARMIN', 'synthetic-denied-user-key')
    await saveProviderApiKey(readyOwner, 'GARMIN', 'synthetic-ready-user-key')
    const state = await runGarminSync(
      deniedOwner,
      {},
      {
        importPage: async () => {
          throw new GarminImportError('ACCESS_DENIED')
        },
      },
    )
    expect(state.status).toBe('ACTION_REQUIRED')
    expect(await findScheduledGarminOwnerId(new Date(), [deniedUser.id, readyUser.id])).toBe(
      readyUser.id,
    )
  })

  it('respects the shared attempt limit and a completed-window cooldown when scheduling', async () => {
    const user = await prisma.user.create({ data: { authSubject: `${prefix}-cooldown` } })
    const scopedOwner = getOwnerContext({ id: user.id, role: 'USER', email: null })
    await saveProviderApiKey(scopedOwner, 'GARMIN', 'synthetic-cooldown-user-key')
    for (let attempt = 0; attempt < 3; attempt++)
      expect(await allowGarminImport(scopedOwner)).toBe(true)
    expect(await findScheduledGarminOwnerId(new Date(), [user.id])).toBeNull()
    await prisma.garminImportRateLimit.update({
      where: { userId: user.id },
      data: { windowStartedAt: new Date(Date.now() - 61_000) },
    })
    expect(await findScheduledGarminOwnerId(new Date(), [user.id])).toBe(user.id)
    const connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { userId_provider: { userId: user.id, provider: 'GARMIN' } },
    })
    await prisma.syncCursor.create({
      data: {
        userId: user.id,
        connectionId: connection.id,
        dataType: 'ACTIVITIES',
        cursorOrCheckpoint: { version: 1, nextDate: null },
        lastSyncedAt: new Date(),
      },
    })
    expect(await findScheduledGarminOwnerId(new Date(), [user.id])).toBeNull()
    await prisma.syncCursor.update({
      where: { connectionId_dataType: { connectionId: connection.id, dataType: 'ACTIVITIES' } },
      data: { lastSyncedAt: new Date(Date.now() - 3_600_001) },
    })
    expect(await findScheduledGarminOwnerId(new Date(), [user.id])).toBe(user.id)
  })
})
