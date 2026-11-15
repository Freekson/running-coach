import { createServer, type Server } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { requestIntervalsPaceSettings } from './pace-client'

const key = 'synthetic-pace-client-key'
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('addresses only the authenticated athlete and only patches missing delivery fields', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 123 }))
  const patch = { threshold_pace: 1000 / 300 }
  await requestIntervalsPaceSettings(key, { fetcher, patch })
  expect(fetcher).toHaveBeenCalledWith(
    'https://intervals.icu/api/v1/athlete/0/sport-settings/Run?recalcHrZones=false',
    expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify(patch),
      cache: 'no-store',
      redirect: 'error',
      headers: expect.objectContaining({
        Authorization: `Basic ${Buffer.from(`API_KEY:${key}`).toString('base64')}`,
      }),
    }),
  )
})

it.each([
  [401, 'INVALID_KEY'],
  [403, 'PERMISSION_REQUIRED'],
  [422, 'CONFIGURATION_CONFLICT'],
  [429, 'RATE_LIMITED'],
  [500, 'PROVIDER_UNAVAILABLE'],
])('maps HTTP %s without exposing provider data', async (status, code) => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(`private ${key}`, { status: Number(status) }))
  await expect(requestIntervalsPaceSettings(key, { fetcher })).rejects.toMatchObject({ code })
  expect(fetcher).toHaveBeenCalledOnce()
})

it.each([200, 401, 403])(
  'treats HTML/challenges as temporary failures for status %s',
  async (status) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('private challenge', { status, headers: { 'cf-mitigated': 'challenge' } }),
      )
    await expect(requestIntervalsPaceSettings(key, { fetcher })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    })
  },
)

it('bounds streamed responses and rejects malformed JSON or keys', async () => {
  for (const body of ['{', 'x'.repeat(512 * 1024 + 1)])
    await expect(
      requestIntervalsPaceSettings(key, { fetcher: vi.fn().mockResolvedValue(new Response(body)) }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
  const fetcher = vi.fn()
  await expect(requestIntervalsPaceSettings('bad key', { fetcher })).rejects.toMatchObject({
    code: 'INVALID_KEY',
  })
  expect(fetcher).not.toHaveBeenCalled()
})

it('exercises serialized requests and timeout against a local HTTP stand-in', async () => {
  const received: { method?: string; url?: string; body: string }[] = []
  const server = createServer(async (request, response) => {
    if (request.url === '/hang') return
    let body = ''
    for await (const chunk of request) body += chunk.toString()
    received.push({ method: request.method, url: request.url, body })
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ id: 123 }))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No local address')
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init)
  }
  await requestIntervalsPaceSettings(key, { fetcher, patch: { threshold_pace: 1000 / 300 } })
  expect(received).toEqual([
    {
      method: 'PUT',
      url: '/api/v1/athlete/0/sport-settings/Run?recalcHrZones=false',
      body: JSON.stringify({ threshold_pace: 1000 / 300 }),
    },
  ])
  await expect(
    requestIntervalsPaceSettings(key, {
      timeoutMs: 25,
      fetcher: (_input, init) => fetch(`http://127.0.0.1:${address.port}/hang`, init),
    }),
  ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
})
