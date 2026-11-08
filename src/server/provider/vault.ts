import 'server-only'

import { randomUUID } from 'node:crypto'
import { type IntegrationProvider, type Prisma } from '@prisma/client'
import { z } from 'zod'
import type { ProviderConnectionStatus } from '@/lib/provider-connection-status'
import { getPrismaClient } from '@/server/db/client'
import {
  ownerId,
  requireOwnedConnection,
  type OwnerContext,
} from '@/server/authorization/ownership'
import {
  CredentialUnavailableError,
  decryptCredential,
  encryptCredential,
} from './credential-crypto'

export const apiKeySchema = z
  .string()
  .min(8)
  .max(2048)
  .regex(/^[\x21-\x7e]+$/)

export class InvalidCredentialError extends Error {
  constructor() {
    super('Invalid provider credential')
  }
}

function publicStatus(
  connection: {
    provider: IntegrationProvider
    status: string
    lastSuccessAt: Date | null
    createdAt: Date
    updatedAt: Date
    credential: { connectionId: string } | null
  } | null,
  provider: IntegrationProvider,
): ProviderConnectionStatus {
  if (!connection) return { provider, status: 'DISCONNECTED', createdAt: null, updatedAt: null }
  const status = !connection.credential
    ? 'DISCONNECTED'
    : connection.status === 'CONNECTED'
      ? provider === 'GARMIN'
        ? connection.lastSuccessAt === null
          ? 'KEY_SAVED'
          : 'CONNECTED'
        : 'CONNECTED'
      : connection.status === 'EXPIRED'
        ? 'EXPIRED'
        : 'ERROR'
  return {
    provider,
    status,
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  }
}

export async function getProviderConnectionStatus(
  owner: OwnerContext,
  provider: IntegrationProvider,
): Promise<ProviderConnectionStatus> {
  const prisma = await getPrismaClient()
  const connection = await prisma.integrationConnection.findUnique({
    where: { userId_provider: { userId: ownerId(owner), provider } },
    select: {
      provider: true,
      status: true,
      lastSuccessAt: true,
      createdAt: true,
      updatedAt: true,
      credential: { select: { connectionId: true } },
    },
  })
  return publicStatus(connection, provider)
}

// One account per owner/provider. No caller supplies an owner or connection ID.
export async function saveProviderApiKey(
  owner: OwnerContext,
  provider: IntegrationProvider,
  rawKey: string,
): Promise<ProviderConnectionStatus> {
  const userId = ownerId(owner)
  const parsed = apiKeySchema.safeParse(rawKey)
  if (!parsed.success) throw new InvalidCredentialError()
  const key = parsed.data
  const prisma = await getPrismaClient()
  const existing = await prisma.integrationConnection.findUnique({
    where: { userId_provider: { userId, provider } },
    select: { id: true },
  })
  if (existing) await requireOwnedConnection(owner, existing.id)
  const connectionId = existing?.id ?? randomUUID()
  const encrypted = encryptCredential(key, userId, connectionId, provider)
  await prisma.$transaction(async (tx) => {
    const connection = await tx.integrationConnection.upsert({
      where: { userId_provider: { userId, provider } },
      create: { id: connectionId, userId, provider, authMethod: 'API_KEY', status: 'PENDING' },
      update: {},
      select: { id: true, authMethod: true },
    })
    if (connection.id !== connectionId || connection.authMethod !== 'API_KEY')
      throw new CredentialUnavailableError()
    await tx.integrationCredential.upsert({
      where: { connectionId: connection.id },
      create: { userId, connectionId: connection.id, ...encrypted },
      update: { ...encrypted },
    })
    await tx.integrationConnection.update({
      where: { userId_id: { userId, id: connection.id } },
      data: { status: 'CONNECTED', lastSuccessAt: null, lastFailureAt: null },
    })
    await tx.syncCursor.deleteMany({ where: { userId, connectionId: connection.id } })
    if (provider === 'GARMIN')
      await tx.garminImportRateLimit.updateMany({
        where: { userId },
        data: { providerRetryAt: null },
      })
    await tx.syncRun.updateMany({
      where: { userId, connectionId: connection.id, status: 'RUNNING' },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        errorCode: 'CREDENTIAL_REPLACED',
        errorSafeMessage: 'Credential changed',
      },
    })
  })
  return getProviderConnectionStatus(owner, provider)
}

// Future provider adapters call this only inside server modules.
export async function readProviderApiKeySnapshot(
  owner: OwnerContext,
  provider: IntegrationProvider,
): Promise<{ key: string; nonce: Uint8Array }> {
  const prisma = await getPrismaClient()
  const connection = await prisma.integrationConnection.findUnique({
    where: { userId_provider: { userId: ownerId(owner), provider } },
    select: {
      id: true,
      status: true,
      authMethod: true,
      credential: {
        select: {
          userId: true,
          connectionId: true,
          ciphertext: true,
          nonce: true,
          authTag: true,
          encryptionKeyVersion: true,
        },
      },
    },
  })
  if (!connection || connection.status !== 'CONNECTED' || connection.authMethod !== 'API_KEY')
    throw new CredentialUnavailableError()
  const credential = connection.credential
  if (
    !credential ||
    credential.userId !== ownerId(owner) ||
    credential.connectionId !== connection.id
  )
    throw new CredentialUnavailableError()
  return {
    key: decryptCredential(credential, ownerId(owner), connection.id, provider),
    nonce: credential.nonce,
  }
}

export async function readProviderApiKey(
  owner: OwnerContext,
  provider: IntegrationProvider,
): Promise<string> {
  return (await readProviderApiKeySnapshot(owner, provider)).key
}

/** Lock the connection while a fetched provider record is persisted. */
export async function assertProviderApiKeySnapshotCurrent(
  tx: Prisma.TransactionClient,
  owner: OwnerContext,
  provider: IntegrationProvider,
  nonce: Uint8Array,
): Promise<void> {
  const userId = ownerId(owner)
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT connection.id
    FROM integration_connections AS connection
    JOIN integration_credentials AS credential
      ON credential.connection_id = connection.id
      AND credential.user_id = connection.user_id
    WHERE connection.user_id = ${userId}::uuid
      AND connection.provider::text = ${provider}
      AND connection.status = 'CONNECTED'
      AND credential.nonce = ${nonce}
    FOR UPDATE OF connection
  `
  if (rows.length !== 1) throw new CredentialUnavailableError()
}

/** The encrypted credential nonce changes on replacement, so an old request cannot update a new key. */
export async function recordProviderApiKeyAccess(
  owner: OwnerContext,
  provider: IntegrationProvider,
  nonce: Uint8Array,
  result: 'VERIFIED' | 'REJECTED',
): Promise<void> {
  const prisma = await getPrismaClient()
  await prisma.integrationConnection.updateMany({
    where: {
      userId: ownerId(owner),
      provider,
      status: 'CONNECTED',
      credential: { is: { userId: ownerId(owner), nonce: Uint8Array.from(nonce) } },
    },
    data:
      result === 'VERIFIED'
        ? { lastSuccessAt: new Date(), lastFailureAt: null }
        : { status: 'ERROR', lastFailureAt: new Date() },
  })
}

export async function disconnectProvider(owner: OwnerContext, provider: IntegrationProvider) {
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  const connection = await prisma.integrationConnection.findUnique({
    where: { userId_provider: { userId, provider } },
    select: { id: true },
  })
  if (!connection) return
  await requireOwnedConnection(owner, connection.id)
  await prisma.$transaction(async (tx) => {
    await tx.integrationConnection.update({
      where: { userId_id: { userId, id: connection.id } },
      data: { status: 'REVOKED' },
    })
    await tx.integrationCredential.deleteMany({ where: { userId, connectionId: connection.id } })
    await tx.syncCursor.deleteMany({ where: { userId, connectionId: connection.id } })
    if (provider === 'GARMIN')
      await tx.garminImportRateLimit.updateMany({
        where: { userId },
        data: { providerRetryAt: null },
      })
    await tx.syncRun.updateMany({
      where: { userId, connectionId: connection.id, status: 'RUNNING' },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        errorCode: 'CONNECTION_REMOVED',
        errorSafeMessage: 'Connection removed',
      },
    })
  })
}
