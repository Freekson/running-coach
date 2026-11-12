import { beforeEach, expect, it, vi } from 'vitest'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'

const {
  getCurrentUser,
  getGarminImportState,
  runGarminDataImport,
  allowGarminImport,
  getGarminImportBlock,
  verifySavedGarminAccount,
} = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getGarminImportState: vi.fn(async () => []),
  runGarminDataImport: vi.fn<(...args: [OwnerContext, unknown]) => Promise<unknown>>(
    async () => [],
  ),
  allowGarminImport: vi.fn(async () => true),
  getGarminImportBlock: vi.fn<
    (...args: [OwnerContext]) => Promise<{ code: string; retryAt: Date } | null>
  >(async () => null),
  verifySavedGarminAccount: vi.fn<(owner: OwnerContext) => Promise<void>>(async () => {}),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({
  getCurrentUser,
  isVerifiedCurrentUser: () => true,
  AccountUnavailableError: class extends Error {},
}))
vi.mock('@/server/garmin/data-import', () => ({
  getGarminImportState,
  runGarminDataImport,
  GarminDataImportError: class extends Error {
    constructor(readonly code: string) {
      super(code)
    }
  },
}))
vi.mock('@/server/garmin/import-rate-limit', () => ({
  allowGarminImport,
  getGarminImportBlock,
}))
vi.mock('@/server/garmin/account-identity', () => ({
  verifySavedGarminAccount,
  GarminAccountIdentityError: class extends Error {},
}))
vi.mock('@/server/provider/vault', () => ({ GarminAccountMismatchError: class extends Error {} }))

import { GET, POST } from './route'
import { GarminDataImportError } from '@/server/garmin/data-import'

const url = 'https://running.example/api/integrations/garmin/import'
function post(body: unknown, origin = 'https://running.example') {
  return new Request(url, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({
    id: '00000000-0000-4000-8000-000000000001',
    role: 'USER',
    email: null,
  })
})

it('requires a session and same-origin request before reading progress or importing', async () => {
  getCurrentUser.mockResolvedValueOnce(null)
  expect((await GET()).status).toBe(401)
  getCurrentUser.mockResolvedValueOnce(null)
  expect(
    (await POST(post({ streamId: 'sleep', action: 'import', browserTimezone: 'UTC' }))).status,
  ).toBe(401)
  expect(
    (
      await POST(
        post(
          { streamId: 'sleep', action: 'import', browserTimezone: 'UTC' },
          'https://other.example',
        ),
      )
    ).status,
  ).toBe(403)
  expect(runGarminDataImport).not.toHaveBeenCalled()
})

it('rejects an oversized streamed body before parsing it', async () => {
  const response = await POST(
    post({ streamId: 'sleep', action: 'import', browserTimezone: 'x'.repeat(300) }),
  )
  expect(response.status).toBe(413)
  expect(runGarminDataImport).not.toHaveBeenCalled()
})

it('derives the owner from the session and rejects a client-selected owner', async () => {
  const userId = '00000000-0000-4000-8000-000000000002'
  getCurrentUser.mockResolvedValue({ id: userId, role: 'ADMIN', email: null })
  expect(
    (
      await POST(
        post({
          streamId: 'sleep',
          action: 'import',
          browserTimezone: 'UTC',
          userId: '00000000-0000-4000-8000-000000000001',
        }),
      )
    ).status,
  ).toBe(400)
  expect(
    (await POST(post({ streamId: 'sleep', action: 'import', browserTimezone: 'UTC' }))).status,
  ).toBe(200)
  expect(ownerId(runGarminDataImport.mock.calls[0][0])).toBe(userId)
  expect(runGarminDataImport.mock.calls[0][1]).toEqual({
    streamId: 'sleep',
    action: 'import',
    browserTimezone: 'UTC',
  })
})

it.each(['import', 'resume', 'retry', 'reimport', 'sync'])(
  'delegates the Activities %s action using the session owner',
  async (action) => {
    const response = await POST(post({ streamId: 'activities', action, browserTimezone: 'UTC' }))
    expect(response.status).toBe(200)
    expect(ownerId(runGarminDataImport.mock.calls[0][0])).toBe(
      '00000000-0000-4000-8000-000000000001',
    )
    expect(runGarminDataImport.mock.calls[0][1]).toEqual({
      streamId: 'activities',
      action,
      browserTimezone: 'UTC',
    })
    expect(verifySavedGarminAccount).not.toHaveBeenCalled()
  },
)

it('verifies a legacy saved key as a separate owner-scoped action', async () => {
  expect(
    (await POST(post({ streamId: 'daily_summary', action: 'verify', browserTimezone: 'UTC' })))
      .status,
  ).toBe(200)
  expect(ownerId(verifySavedGarminAccount.mock.calls[0][0])).toBe(
    '00000000-0000-4000-8000-000000000001',
  )
  expect(runGarminDataImport).not.toHaveBeenCalled()
})

it('returns the persisted retry time when Garmin limits an import', async () => {
  const retryAt = new Date(Date.now() + 90_000)
  getGarminImportBlock.mockResolvedValueOnce({ code: 'RATE_LIMITED', retryAt })
  runGarminDataImport.mockRejectedValueOnce(new GarminDataImportError('RATE_LIMITED'))
  const response = await POST(post({ streamId: 'sleep', action: 'retry', browserTimezone: 'UTC' }))
  expect(response.status).toBe(429)
  expect(response.headers.get('Retry-After')).toMatch(/^\d+$/)
  expect(await response.json()).toEqual({ code: 'RATE_LIMITED', retryAt: retryAt.toISOString() })
  expect(getGarminImportBlock).toHaveBeenCalledWith(
    expect.objectContaining({ userId: '00000000-0000-4000-8000-000000000001' }),
  )
})

it('accepts only an owner-scoped Activities laps stage and rejects client-selected activity IDs', async () => {
  expect(
    (
      await POST(
        post({ streamId: 'activities', stage: 'laps', action: 'retry', browserTimezone: 'UTC' }),
      )
    ).status,
  ).toBe(200)
  expect(runGarminDataImport.mock.calls[0][1]).toMatchObject({
    streamId: 'activities',
    stage: 'laps',
    action: 'retry',
  })
  for (const extra of [{ activityId: 'other-user-activity' }, { userId: 'other-user' }])
    expect(
      (
        await POST(
          post({
            streamId: 'activities',
            stage: 'laps',
            action: 'resume',
            browserTimezone: 'UTC',
            ...extra,
          }),
        )
      ).status,
    ).toBe(400)
  expect(
    (
      await POST(
        post({ streamId: 'sleep', stage: 'laps', action: 'resume', browserTimezone: 'UTC' }),
      )
    ).status,
  ).toBe(400)
})
