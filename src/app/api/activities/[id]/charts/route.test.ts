import { beforeEach, expect, it, vi } from 'vitest'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { NodeNextRequest } from 'next/dist/server/base-http/node'
import { NextRequestAdapter } from 'next/dist/server/web/spec-extension/adapters/next-request'
const { user, load } = vi.hoisted(() => ({ user: vi.fn(), load: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({
  getCurrentUser: user,
  isVerifiedCurrentUser: () => true,
  AccountUnavailableError: class extends Error {},
}))
vi.mock('@/server/activity/charts', async (original) => {
  const actual = await original<typeof import('@/server/activity/charts')>()
  return { ...actual, loadActivityCharts: load }
})
import { POST } from './route'
import { ActivityChartsError } from '@/server/activity/charts'
import { AccountUnavailableError } from '@/server/auth/current-user'
const id = '00000000-0000-4000-8000-000000000079'
const context = { params: Promise.resolve({ id }) }
const url = `https://coach.example.test/api/activities/${id}/charts`
function request(origin = 'https://coach.example.test', body?: string) {
  return new Request(url, { method: 'POST', headers: { Origin: origin }, body })
}
beforeEach(() => {
  vi.clearAllMocks()
  user.mockResolvedValue({ id: '00000000-0000-4000-8000-000000000001', role: 'USER' })
  load.mockResolvedValue({ samples: [] })
})
it('authenticates every request, derives the owner from the session and returns no-store data', async () => {
  const response = await POST(request(), context)
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(load).toHaveBeenCalledWith({ userId: '00000000-0000-4000-8000-000000000001' }, id)
  user.mockResolvedValue({ id: '00000000-0000-4000-8000-000000000002', role: 'ADMIN' })
  load.mockRejectedValue(new ActivityChartsError('NOT_FOUND', 404))
  expect((await POST(request(), context)).status).toBe(404)
  expect(load).toHaveBeenLastCalledWith({ userId: '00000000-0000-4000-8000-000000000002' }, id)
})
it('rejects anonymous/disabled users, cross-origin requests, unsafe IDs and extra payloads', async () => {
  user.mockResolvedValueOnce(null)
  expect((await POST(request(), context)).status).toBe(401)
  user.mockRejectedValueOnce(new AccountUnavailableError())
  expect((await POST(request(), context)).status).toBe(403)
  expect((await POST(request('https://other.example.test'), context)).status).toBe(403)
  expect((await POST(request(), { params: Promise.resolve({ id: '../other' }) })).status).toBe(400)
  expect(
    (await POST(request(undefined, JSON.stringify({ userId: 'another-owner' })), context)).status,
  ).toBe(400)
  expect(load).not.toHaveBeenCalled()
})
it('preserves Retry-After without leaking unexpected provider error details', async () => {
  load.mockRejectedValueOnce(
    new ActivityChartsError('RATE_LIMITED', 429, new Date(Date.now() + 60_000)),
  )
  const limited = await POST(request(), context)
  expect(limited.status).toBe(429)
  expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)
  load.mockRejectedValueOnce(new Error('synthetic-private-token-and-coordinates'))
  const failed = await POST(request(), context)
  expect(failed.status).toBe(503)
  expect(await failed.json()).toEqual({ code: 'UNAVAILABLE', retryAt: null })
})

it('accepts an empty POST represented by the Next.js Node request adapter', async () => {
  const socket = new Socket()
  const incoming = new IncomingMessage(socket)
  incoming.method = 'POST'
  incoming.url = url
  incoming.headers = { origin: 'https://coach.example.test', 'content-length': '0' }
  incoming.push(null)
  try {
    const adapted = NextRequestAdapter.fromNodeNextRequest(
      new NodeNextRequest(incoming),
      new AbortController().signal,
    )
    expect(adapted.body).not.toBeNull()
    expect((await POST(adapted, context)).status).toBe(200)
    expect(load).toHaveBeenCalledOnce()
  } finally {
    incoming.destroy()
    socket.destroy()
  }
})

function streamedRequest(chunks: Uint8Array[], cancel?: () => void) {
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers: { Origin: 'https://coach.example.test' },
    duplex: 'half',
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
      cancel,
    }),
  }
  return new Request(url, init)
}

it('accepts empty string and zero-byte streamed bodies without relying on Content-Length', async () => {
  for (const empty of [
    request(undefined, ''),
    streamedRequest([]),
    streamedRequest([new Uint8Array()]),
  ]) {
    expect(empty.body).not.toBeNull()
    expect((await POST(empty, context)).status).toBe(200)
  }
  expect(load).toHaveBeenCalledTimes(3)
})

it('rejects actual streamed bytes even after empty chunks or a misleading zero Content-Length', async () => {
  const invalid = streamedRequest([new Uint8Array(), new TextEncoder().encode('{}')])
  invalid.headers.set('Content-Length', '0')
  const response = await POST(invalid, context)
  expect(response.status).toBe(400)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(load).not.toHaveBeenCalled()
})

it('rejects unreadable streams or cancellation failures before downloading FIT', async () => {
  const brokenInit: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers: { Origin: 'https://coach.example.test' },
    duplex: 'half',
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('Synthetic stream failure'))
      },
    }),
  }
  expect((await POST(new Request(url, brokenInit), context)).status).toBe(400)
  const cancelInit: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers: { Origin: 'https://coach.example.test' },
    duplex: 'half',
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{}'))
      },
      cancel() {
        throw new Error('Synthetic cancellation failure')
      },
    }),
  }
  expect((await POST(new Request(url, cancelInit), context)).status).toBe(400)
  expect(load).not.toHaveBeenCalled()
})
