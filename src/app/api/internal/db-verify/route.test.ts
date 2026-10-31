import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPrismaClient } from '@/server/db/client'
import { HEAD } from './route'

vi.mock('@/server/db/client', () => ({ getPrismaClient: vi.fn() }))

const token = 'synthetic-token-with-at-least-32-chars'
const originalToken = process.env.DB_VERIFY_TOKEN

function verificationRequest(value?: string): Request {
  return new Request('http://localhost/api/internal/db-verify', {
    method: 'HEAD',
    headers: value ? { 'x-db-verify-token': value } : {},
  })
}

describe('private database verification route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.DB_VERIFY_TOKEN = token
  })

  afterEach(() => {
    if (originalToken === undefined) delete process.env.DB_VERIFY_TOKEN
    else process.env.DB_VERIFY_TOKEN = originalToken
  })

  it('returns no database information or client call without a valid token', async () => {
    for (const request of [verificationRequest(), verificationRequest('wrong-token')]) {
      const response = await HEAD(request)
      expect(response.status).toBe(404)
      expect(await response.text()).toBe('')
      expect(response.headers.get('Cache-Control')).toContain('no-store')
    }
    expect(getPrismaClient).not.toHaveBeenCalled()
  })

  it('stays unavailable when the server token is missing or too short', async () => {
    delete process.env.DB_VERIFY_TOKEN
    expect((await HEAD(verificationRequest(token))).status).toBe(404)
    process.env.DB_VERIFY_TOKEN = 'short'
    expect((await HEAD(verificationRequest('short'))).status).toBe(404)
    expect(getPrismaClient).not.toHaveBeenCalled()
  })

  it('returns an empty success only after private verification succeeds', async () => {
    const response = await HEAD(verificationRequest(token))
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(getPrismaClient).toHaveBeenCalledOnce()
  })

  it('returns only an empty failure when the database identity fails', async () => {
    vi.mocked(getPrismaClient).mockRejectedValueOnce(new Error('private database detail'))
    const response = await HEAD(verificationRequest(token))
    expect(response.status).toBe(503)
    expect(await response.text()).toBe('')
  })
})
