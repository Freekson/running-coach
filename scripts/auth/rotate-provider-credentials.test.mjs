import { afterEach, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'

vi.mock('server-only', () => ({}))
vi.mock('@/server/db/client', () => ({ getPrismaClient: vi.fn().mockResolvedValue({}) }))

import { encryptCredential, decryptCredential } from '../../src/server/provider/credential-crypto'
import { HEAD } from '../../src/app/api/internal/credential-key-verify/route'
import {
  directDatabaseTarget,
  reencryptCredential,
  requiresDeploymentProof,
  rotationTierFor,
  verifyCredential,
  verifyDeployedKey,
  verifyDeploymentKeys,
} from './rotate-provider-credentials.mjs'

const previous = {
  active: process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION,
  first: process.env.CREDENTIAL_ENCRYPTION_KEY_V1,
  second: process.env.CREDENTIAL_ENCRYPTION_KEY_V2,
  databaseUrl: process.env.DATABASE_URL,
  token: process.env.DB_VERIFY_TOKEN,
}
const directUrl = 'postgresql://migrator:synthetic@ep-production.us-east-1.aws.neon.tech/coach'
const databaseTarget = directDatabaseTarget(new URL(directUrl))

it('identifies the direct database endpoint, name and schema without credentials', () => {
  expect(databaseTarget).toBe(
    JSON.stringify(['ep-production.us-east-1.aws.neon.tech', '', '/coach', 'public']),
  )
  expect(databaseTarget).not.toContain('synthetic')
  expect(directDatabaseTarget(new URL(`${directUrl}?schema=public`))).toBe(databaseTarget)
  expect(directDatabaseTarget(new URL(directUrl.replace('.tech/', '.tech:5432/')))).toBe(
    databaseTarget,
  )
  expect(directDatabaseTarget(new URL(directUrl.replace('/coach', '/restored')))).not.toBe(
    databaseTarget,
  )
})

it('rejects a restored database copy even when the deployed app has the same key', async () => {
  const token = 'synthetic-verification-token-at-least-32-bytes'
  process.env.DB_VERIFY_TOKEN = token
  process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '2'
  process.env.CREDENTIAL_ENCRYPTION_KEY_V2 = Buffer.alloc(32, 32).toString('base64')
  process.env.DATABASE_URL =
    'postgresql://app:synthetic@ep-production-pooler.us-east-1.aws.neon.tech/coach'
  const fetchDeployment = async (url, init) =>
    HEAD(new Request(url, { method: init.method, headers: init.headers }))

  await expect(
    verifyDeployedKey('https://coach.example.test', token, 2, 2, databaseTarget, fetchDeployment),
  ).resolves.toBeUndefined()
  await expect(
    verifyDeployedKey(
      'https://coach.example.test',
      token,
      2,
      2,
      directDatabaseTarget(new URL(directUrl.replace('/coach', '/restored'))),
      fetchDeployment,
    ),
  ).rejects.toThrow('Deployment key verification failed')
})

afterEach(() => {
  for (const [name, value] of [
    ['CREDENTIAL_ENCRYPTION_ACTIVE_VERSION', previous.active],
    ['CREDENTIAL_ENCRYPTION_KEY_V1', previous.first],
    ['CREDENTIAL_ENCRYPTION_KEY_V2', previous.second],
    ['DATABASE_URL', previous.databaseUrl],
    ['DB_VERIFY_TOKEN', previous.token],
  ]) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

it('re-encrypts a vault row for the active version without changing its secret', () => {
  process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1'
  process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = Buffer.alloc(32, 31).toString('base64')
  process.env.CREDENTIAL_ENCRYPTION_KEY_V2 = Buffer.alloc(32, 32).toString('base64')
  const first = encryptCredential('synthetic-key-for-rotation', 'owner-a', 'connection-a', 'OPENAI')
  const row = {
    ...first,
    userId: 'owner-a',
    connectionId: 'connection-a',
    connection: { userId: 'owner-a', provider: 'OPENAI', authMethod: 'API_KEY' },
  }
  const second = reencryptCredential(row, 2)
  const activeRow = { ...row, ...second }
  expect(() => verifyCredential(activeRow)).not.toThrow()
  const tampered = { ...activeRow, ciphertext: Buffer.from(activeRow.ciphertext) }
  tampered.ciphertext[0] ^= 1
  expect(() => verifyCredential(tampered)).toThrow()
  expect(second.encryptionKeyVersion).toBe(2)
  expect(second.ciphertext).not.toEqual(first.ciphertext)
  expect(decryptCredential(second, 'owner-a', 'connection-a', 'OPENAI')).toBe(
    'synthetic-key-for-rotation',
  )
  expect(() =>
    reencryptCredential({ ...row, connection: { ...row.connection, userId: 'b' } }, 2),
  ).toThrow()
})

it('requires the deployed app to prove it has the operator’s active key', async () => {
  const key = Buffer.alloc(32, 32)
  process.env.CREDENTIAL_ENCRYPTION_KEY_V2 = key.toString('base64')
  const token = 'synthetic-verification-token-at-least-32-bytes'
  const fetchProof = vi.fn(async (_url, init) => {
    expect(init.method).toBe('HEAD')
    expect(init.headers['x-db-verify-token']).toBe(token)
    expect(init.headers['x-credential-key-version']).toBe('2')
    const challenge = Buffer.from(init.headers['x-credential-rotation-challenge'], 'base64url')
    const proof = createHmac('sha256', key)
      .update('running-coach:credential-rotation:v2:')
      .update(challenge)
      .update(databaseTarget)
      .digest('base64url')
    return new Response(null, {
      status: 204,
      headers: {
        'x-credential-key-version': '2',
        'x-credential-active-version': '2',
        'x-credential-key-proof': proof,
      },
    })
  })
  await expect(
    verifyDeployedKey('https://coach.example.test', token, 2, 2, databaseTarget, fetchProof),
  ).resolves.toBeUndefined()
  expect(fetchProof).toHaveBeenCalledOnce()
  await expect(
    verifyDeployedKey(
      'https://coach.example.test',
      token,
      2,
      2,
      databaseTarget,
      async () =>
        new Response(null, {
          status: 204,
          headers: {
            'x-credential-key-version': '2',
            'x-credential-active-version': '2',
            'x-credential-key-proof': 'wrong',
          },
        }),
    ),
  ).rejects.toThrow('Deployment key verification failed')
  await expect(
    verifyDeployedKey('http://coach.example.test', token, 2, 2, databaseTarget, fetchProof),
  ).rejects.toThrow('Invalid deployment origin')
  expect(fetchProof).toHaveBeenCalledOnce()
  await expect(
    verifyDeployedKey(
      'https://coach.example.test',
      token,
      2,
      2,
      databaseTarget.replace('/coach', '/restored'),
      fetchProof,
    ),
  ).rejects.toThrow('Deployment key verification failed')
})

it('checks every stored key version before rotation and rejects a missing historical key', async () => {
  const keys = new Map([
    [1, Buffer.alloc(32, 31)],
    [2, Buffer.alloc(32, 32)],
  ])
  process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = keys.get(1).toString('base64')
  process.env.CREDENTIAL_ENCRYPTION_KEY_V2 = keys.get(2).toString('base64')
  const token = 'synthetic-verification-token-at-least-32-bytes'
  const fetchProof = vi.fn(async (_url, init) => {
    const version = Number(init.headers['x-credential-key-version'])
    const challenge = Buffer.from(init.headers['x-credential-rotation-challenge'], 'base64url')
    const proof = createHmac('sha256', keys.get(version))
      .update('running-coach:credential-rotation:v2:')
      .update(challenge)
      .update(databaseTarget)
      .digest('base64url')
    return new Response(null, {
      status: 204,
      headers: {
        'x-credential-key-version': String(version),
        'x-credential-active-version': '2',
        'x-credential-key-proof': proof,
      },
    })
  })
  await expect(
    verifyDeploymentKeys(
      'https://coach.example.test',
      token,
      2,
      [1, 2],
      databaseTarget,
      fetchProof,
    ),
  ).resolves.toEqual(new Set([2, 1]))
  expect(fetchProof).toHaveBeenCalledTimes(2)
  await expect(
    verifyDeploymentKeys(
      'https://coach.example.test',
      token,
      2,
      [1],
      databaseTarget,
      async (_url, init) => {
        if (init.headers['x-credential-key-version'] === '1')
          return new Response(null, { status: 503 })
        return fetchProof(_url, init)
      },
    ),
  ).rejects.toThrow('Deployment key verification failed')
})

it('accepts Preview as a non-production rotation target', () => {
  expect(rotationTierFor('preview')).toBe('NON_PRODUCTION')
  expect(rotationTierFor('production')).toBe('PRODUCTION')
  expect(() => rotationTierFor(undefined)).toThrow()
  expect(requiresDeploymentProof('--apply', 'preview', '127.0.0.1')).toBe(true)
  expect(requiresDeploymentProof('--apply', 'production', '127.0.0.1')).toBe(true)
  expect(requiresDeploymentProof('--apply', 'development', 'db.neon.tech')).toBe(true)
  expect(requiresDeploymentProof('--apply', 'development', '127.0.0.1')).toBe(false)
  expect(requiresDeploymentProof('--check', 'preview', 'db.neon.tech')).toBe(false)
})
