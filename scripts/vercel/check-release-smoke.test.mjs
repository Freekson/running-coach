import { expect, it, vi } from 'vitest'
import { checkReleaseSmoke } from './check-release-smoke.mjs'
const token = 'synthetic-verification-token-at-least-32-bytes'

it('checks auth boundaries and DB identity without following redirects or creating accounts', async () => {
  const fetcher = vi.fn(async (_url, init) => {
    expect(init.redirect).toBe('manual')
    const headers = { 'Cache-Control': 'private, no-store' }
    if (_url.endsWith('/status')) return new Response(null, { status: 200 })
    if (init.body) {
      expect(JSON.parse(init.body)).toEqual({})
      return new Response(null, {
        status: 403,
        headers: { 'X-Running-Coach-Error': 'invalid-invitation' },
      })
    }
    if (init.method === 'HEAD')
      return new Response(null, { status: init.headers['x-db-verify-token'] ? 204 : 404, headers })
    return new Response(null, { status: 401, headers })
  })
  expect(await checkReleaseSmoke('https://coach.example.test', token, fetcher)).toHaveLength(6)
  expect(fetcher.mock.calls.filter(([, init]) => init.headers['x-db-verify-token'])).toHaveLength(1)
})

it('fails closed on redirects and never echoes response bodies or secret-bearing errors', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('synthetic-health', { status: 302 }))
  await expect(checkReleaseSmoke('https://coach.example.test', token, fetcher)).rejects.toThrow(
    'Release smoke failed: status page.',
  )
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it.each([
  'http://public.example.test',
  'https://user:secret@example.test',
  'https://example.test/path',
  'https://example.test?token=secret',
])('rejects unsafe origins before sending a token: %s', async (base) => {
  const fetcher = vi.fn()
  await expect(checkReleaseSmoke(base, token, fetcher)).rejects.toThrow(
    'Supply a bare HTTPS origin',
  )
  expect(fetcher).not.toHaveBeenCalled()
})
