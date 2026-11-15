import { createServer, type Server } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { connectIntervals, IntervalsConnectionError, verifyIntervalsApiKey } from './connection'

it('rejects an unissued owner context before contacting the provider', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    await expect(connectIntervals({ userId: 'forged-owner' }, 'synthetic-key')).rejects.toThrow(
      'Verified owner context required',
    )
    expect(fetcher).not.toHaveBeenCalled()
  } finally {
    fetcher.mockRestore()
  }
})

const key = 'synthetic-intervals-key'
const now = new Date('2026-11-14T12:00:00Z')

it('checks only the authenticated athlete calendar with Basic auth and discards its contents', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json([{ id: 123, name: 'Synthetic workout' }]))
  expect(await verifyIntervalsApiKey(key, { fetcher, now })).toBeUndefined()
  const [url, options] = fetcher.mock.calls[0]
  expect(String(url)).toBe(
    'https://intervals.icu/api/v1/athlete/0/events?oldest=2026-11-14&newest=2026-11-14&category=WORKOUT',
  )
  expect(options).toMatchObject({
    method: 'GET',
    cache: 'no-store',
    redirect: 'error',
    headers: {
      Authorization: `Basic ${Buffer.from(`API_KEY:${key}`).toString('base64')}`,
      Accept: 'application/json',
    },
  })
  expect(fetcher).toHaveBeenCalledOnce()
})

it('accepts an empty calendar without requiring existing workouts', async () => {
  await expect(
    verifyIntervalsApiKey(key, { fetcher: vi.fn().mockResolvedValue(Response.json([])) }),
  ).resolves.toBeUndefined()
})

it.each([
  [401, 'INVALID_KEY'],
  [403, 'INVALID_KEY'],
  [429, 'RATE_LIMITED'],
  [500, 'PROVIDER_UNAVAILABLE'],
  [302, 'PROVIDER_UNAVAILABLE'],
])('maps HTTP %s without exposing provider errors', async (status, code) => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(`secret ${key}`, { status: Number(status) }))
  await expect(verifyIntervalsApiKey(key, { fetcher })).rejects.toMatchObject({
    code,
    message: 'Intervals.icu connection could not be verified',
  })
})

it.each(['<html>maintenance</html>', '{}', '[{"name":"no id"}]', 'null'])(
  'rejects malformed calendar data %s',
  async (body) => {
    await expect(
      verifyIntervalsApiKey(key, { fetcher: vi.fn().mockResolvedValue(new Response(body)) }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
  },
)

it.each([200, 401, 403])(
  'treats Cloudflare challenges and HTML HTTP %s as temporary provider failures',
  async (status) => {
    for (const headers of [
      new Headers({ 'cf-mitigated': 'challenge' }),
      new Headers({ 'content-type': 'text/html; charset=UTF-8' }),
      new Headers({ 'content-type': 'application/xhtml+xml' }),
    ]) {
      const fetcher = vi.fn().mockResolvedValue(new Response('challenge', { status, headers }))
      await expect(verifyIntervalsApiKey(key, { fetcher })).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
      })
    }
  },
)

it('bounds streamed responses and rejects invalid keys before a request', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(' '.repeat(512 * 1024 + 1)))
  await expect(verifyIntervalsApiKey(key, { fetcher })).rejects.toBeInstanceOf(
    IntervalsConnectionError,
  )
  fetcher.mockClear()
  await expect(verifyIntervalsApiKey('bad key', { fetcher })).rejects.toMatchObject({
    code: 'INVALID_KEY',
  })
  expect(fetcher).not.toHaveBeenCalled()
})

// Exercise the actual fetch transport and abort signal, without credentials or live provider calls.
let server: Server | undefined
afterEach(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    )
    server = undefined
  }
})

it('uses real HTTP serialization and honors the timeout against a local stand-in', async () => {
  const requests: { path?: string; method?: string; auth?: string }[] = []
  let hang = false
  server = createServer((request, response) => {
    requests.push({
      path: request.url,
      method: request.method,
      auth: request.headers.authorization,
    })
    if (!hang) {
      response.setHeader('Content-Type', 'application/json')
      response.end('[]')
    }
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Local server unavailable')
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(String(input))
    return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init)
  }
  await verifyIntervalsApiKey(key, { fetcher, now })
  expect(requests[0]).toEqual({
    path: '/api/v1/athlete/0/events?oldest=2026-11-14&newest=2026-11-14&category=WORKOUT',
    method: 'GET',
    auth: `Basic ${Buffer.from(`API_KEY:${key}`).toString('base64')}`,
  })
  hang = true
  await expect(verifyIntervalsApiKey(key, { fetcher, timeoutMs: 100 })).rejects.toMatchObject({
    code: 'PROVIDER_UNAVAILABLE',
  })
  expect(requests).toHaveLength(2)
})
