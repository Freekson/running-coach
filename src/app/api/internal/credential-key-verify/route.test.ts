import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getPrismaClient } = vi.hoisted(() => ({ getPrismaClient: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/db/client', () => ({ getPrismaClient }))

import { HEAD } from './route'

const token = 'synthetic-verification-token-at-least-32-bytes'
const key = Buffer.alloc(32, 51)
const historicalKey = Buffer.alloc(32, 52)
const challenge = Buffer.alloc(32, 9).toString('base64url')
const pooledUrl =
  'postgresql://app:synthetic@ep-production-pooler.us-east-1.aws.neon.tech/coach?schema=public'
const databaseTarget = JSON.stringify([
  'ep-production.us-east-1.aws.neon.tech',
  '',
  '/coach',
  'public',
])
const previous = {
  token: process.env.DB_VERIFY_TOKEN,
  databaseUrl: process.env.DATABASE_URL,
  version: process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION,
  key: process.env.CREDENTIAL_ENCRYPTION_KEY_V2,
  historicalKey: process.env.CREDENTIAL_ENCRYPTION_KEY_V1,
}

function request(suppliedToken = token, suppliedChallenge = challenge, keyVersion = '2') {
  return new Request('https://coach.example.test/api/internal/credential-key-verify', {
    method: 'HEAD',
    headers: {
      'x-db-verify-token': suppliedToken,
      'x-credential-rotation-challenge': suppliedChallenge,
      'x-credential-key-version': keyVersion,
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.DB_VERIFY_TOKEN = token
  process.env.DATABASE_URL = pooledUrl
  process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '2'
  process.env.CREDENTIAL_ENCRYPTION_KEY_V2 = key.toString('base64')
  process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = historicalKey.toString('base64')
})

afterEach(() => {
  if (previous.token === undefined) delete process.env.DB_VERIFY_TOKEN
  else process.env.DB_VERIFY_TOKEN = previous.token
  if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = previous.databaseUrl
  if (previous.version === undefined) delete process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION
  else process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = previous.version
  if (previous.key === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY_V2
  else process.env.CREDENTIAL_ENCRYPTION_KEY_V2 = previous.key
  if (previous.historicalKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY_V1
  else process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = previous.historicalKey
})

describe('private credential key verification route', () => {
  it('requires the existing private verification token and a valid random challenge', async () => {
    expect((await HEAD(request('wrong-token'))).status).toBe(404)
    expect((await HEAD(request(token, 'invalid'))).status).toBe(400)
    expect((await HEAD(request(token, challenge, '0'))).status).toBe(400)
    expect(getPrismaClient).not.toHaveBeenCalled()
  })

  it('returns only a challenge proof after verifying the database target', async () => {
    const response = await HEAD(request())
    const expected = createHmac('sha256', key)
      .update('running-coach:credential-rotation:v2:')
      .update(Buffer.from(challenge, 'base64url'))
      .update(databaseTarget)
      .digest('base64url')
    expect(response.status).toBe(204)
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(response.headers.get('x-credential-key-version')).toBe('2')
    expect(response.headers.get('x-credential-active-version')).toBe('2')
    expect(response.headers.get('x-credential-key-proof')).toBe(expected)
    expect(await response.text()).toBe('')
    expect(JSON.stringify([...response.headers])).not.toContain(key.toString('base64'))
    expect(getPrismaClient).toHaveBeenCalledOnce()
  })

  it('proves a historical key while preserving the active version', async () => {
    const response = await HEAD(request(token, challenge, '1'))
    const expected = createHmac('sha256', historicalKey)
      .update('running-coach:credential-rotation:v2:')
      .update(Buffer.from(challenge, 'base64url'))
      .update(databaseTarget)
      .digest('base64url')
    expect(response.status).toBe(204)
    expect(response.headers.get('x-credential-key-version')).toBe('1')
    expect(response.headers.get('x-credential-active-version')).toBe('2')
    expect(response.headers.get('x-credential-key-proof')).toBe(expected)
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_V1
    expect((await HEAD(request(token, challenge, '1'))).status).toBe(503)
  })

  it('fails closed when database verification or active key material is unavailable', async () => {
    getPrismaClient.mockRejectedValueOnce(new Error('private database detail'))
    expect((await HEAD(request())).status).toBe(503)
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_V2
    expect((await HEAD(request())).status).toBe(503)
  })

  it('binds the proof to the deployed database endpoint, name and schema', async () => {
    const expected = (await HEAD(request())).headers.get('x-credential-key-proof')
    process.env.DATABASE_URL = pooledUrl.replace('.tech/', '.tech:5432/')
    expect((await HEAD(request())).headers.get('x-credential-key-proof')).toBe(expected)
    process.env.DATABASE_URL = pooledUrl.replace('/coach?', '/restored?')
    expect((await HEAD(request())).headers.get('x-credential-key-proof')).not.toBe(expected)
    process.env.DATABASE_URL = pooledUrl.replace('schema=public', 'schema=restored')
    expect((await HEAD(request())).headers.get('x-credential-key-proof')).not.toBe(expected)
    process.env.DATABASE_URL = pooledUrl.replace('ep-production-', 'ep-restored-')
    expect((await HEAD(request())).headers.get('x-credential-key-proof')).not.toBe(expected)
  })
})
