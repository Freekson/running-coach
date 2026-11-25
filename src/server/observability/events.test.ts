import { afterEach, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { reportOperationalFailure, safeOperationalCode } from './events'

afterEach(() => vi.restoreAllMocks())

it('projects failures into fixed fields without serializing untrusted content', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const payload = {
    token: 'synthetic-secret',
    health: { heartRate: 140 },
    message: 'provider body',
  }
  reportOperationalFailure('garmin_sync', payload)
  expect(JSON.parse(warn.mock.calls[0][0])).toEqual({
    event: 'operation_failed',
    eventId: expect.any(String),
    operation: 'garmin_sync',
    code: 'UNKNOWN_ERROR',
  })
  expect(warn.mock.calls[0][0]).not.toContain('synthetic-secret')
  expect(safeOperationalCode('RATE_LIMITED\nAuthorization: secret')).toBe('UNKNOWN_ERROR')
  expect(safeOperationalCode('SLEEP_HTTP_503')).toBe('SLEEP_HTTP_503')
  expect(safeOperationalCode('SLEEP_HTTP_503 secret')).toBe('UNKNOWN_ERROR')
  expect(safeOperationalCode('RECOVERY_REQUIRED')).toBe('RECOVERY_REQUIRED')
  expect(safeOperationalCode('PARTIAL_IMPORT')).toBe('PARTIAL_IMPORT')
})

it('does not let a reporting failure prevent durable failure handling', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {
    throw new Error('sink unavailable')
  })
  expect(() => reportOperationalFailure('intervals_publish', 'PROVIDER_UNAVAILABLE')).not.toThrow()
})
