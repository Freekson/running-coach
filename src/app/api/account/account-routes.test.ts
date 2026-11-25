import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getOwnerContext: vi.fn(),
  deleteAccount: vi.fn(),
  exportAccount: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({
  getCurrentUser: mocks.getCurrentUser,
  AccountUnavailableError: class extends Error {},
}))
vi.mock('@/server/authorization/ownership', () => ({ getOwnerContext: mocks.getOwnerContext }))
vi.mock('@/server/account/deletion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/account/deletion')>()),
  deleteAccount: mocks.deleteAccount,
}))
vi.mock('@/server/account/export', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/account/export')>()),
  exportAccount: mocks.exportAccount,
}))

import { AccountUnavailableError } from '@/server/auth/current-user'
import { AccountBusyError } from '@/server/account/deletion'
import { DELETE } from './route'
import { GET } from './export/route'

const input = { confirmation: 'DELETE', providerAccessRevoked: true }
function request(body: unknown = input, origin: string | null = 'https://app.example') {
  return new Request('https://app.example/api/account?userId=other', {
    method: 'DELETE',
    headers: { ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.getCurrentUser.mockResolvedValue({ id: 'owner', role: 'USER' })
  mocks.getOwnerContext.mockReturnValue({ userId: 'verified-owner' })
})

describe('account routes', () => {
  it('denies anonymous and unavailable accounts before accessing records', async () => {
    for (const state of [null, new AccountUnavailableError()]) {
      if (state) mocks.getCurrentUser.mockRejectedValue(state)
      else mocks.getCurrentUser.mockResolvedValue(null)
      for (const response of [await GET(), await DELETE(request())]) {
        expect(response.status).toBe(state ? 403 : 401)
        expect(response.headers.get('Cache-Control')).toBe('private, no-store')
      }
    }
    expect(mocks.exportAccount).not.toHaveBeenCalled()
    expect(mocks.deleteAccount).not.toHaveBeenCalled()
  })

  it.each([null, 'https://attacker.example'])('denies deletion with origin %s', async (origin) => {
    expect((await DELETE(request(input, origin))).status).toBe(403)
    expect(mocks.deleteAccount).not.toHaveBeenCalled()
  })

  it.each([
    {},
    { ...input, userId: 'other' },
    { ...input, confirmation: 'delete' },
    { ...input, providerAccessRevoked: false },
  ])('requires exact confirmation without a client owner: %j', async (body) => {
    expect((await DELETE(request(body))).status).toBe(400)
    expect(mocks.deleteAccount).not.toHaveBeenCalled()
  })

  it('uses only the verified owner, including for ADMIN', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'admin', role: 'ADMIN' })
    expect((await DELETE(request())).status).toBe(204)
    expect(mocks.deleteAccount).toHaveBeenCalledWith({ userId: 'verified-owner' }, input)
  })

  it('streams a private archive with exact Unicode and 64-bit integer serialization', async () => {
    const name = 'A'.repeat(16_380) + '🏃' + 'B'.repeat(20_000)
    mocks.exportAccount.mockResolvedValue({
      format: 'running-coach.account-export',
      name,
      duration: BigInt('9007199254740993'),
    })
    const response = await GET()
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Disposition')).toContain('attachment;')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.json()).toEqual({
      format: 'running-coach.account-export',
      name,
      duration: '9007199254740993',
    })
    expect(mocks.exportAccount).toHaveBeenCalledWith({ userId: 'verified-owner' })
  })

  it('returns retryable conflicts and keeps database errors private', async () => {
    mocks.deleteAccount.mockRejectedValue(new AccountBusyError())
    expect((await DELETE(request())).status).toBe(409)
    mocks.deleteAccount.mockRejectedValue(new Error('PRIVATE DATABASE URL AND TOKEN'))
    const deletion = await DELETE(request())
    expect(deletion.status).toBe(503)
    expect(await deletion.text()).not.toContain('PRIVATE')
    mocks.exportAccount.mockRejectedValue(new Error('PRIVATE HEALTH AND KEY'))
    const download = await GET()
    expect(download.status).toBe(503)
    expect(await download.text()).not.toContain('PRIVATE')
  })
})
