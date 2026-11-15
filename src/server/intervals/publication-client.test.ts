import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { intervalsPublicationClient, sameRemotePublication } from './publication-client'
import { publicationMapping, publicationPayloadSchema } from './publication-contract'
import { approvedPublicationFixture, publicationProviderFixture } from './publication.fixtures'
import { assertIntervalsWorkoutExport } from './workout-export'

const closing: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closing.splice(0)) await close()
})

it('serializes idempotent upsert, lookup, FIT export and cancellation over real HTTP', async () => {
  const provider = await publicationProviderFixture()
  closing.push(provider.close)
  const client = intervalsPublicationClient('synthetic-client-key', { fetcher: provider.fetcher })
  const source = approvedPublicationFixture(randomUUID())
  const { userId, ...raw } = source
  expect(userId).toBeTruthy()
  const payload = publicationPayloadSchema.parse(raw)
  const event = publicationMapping(payload, 'running-coach:synthetic').event
  expect(await client.athleteId()).toBe('synthetic-client-key')
  expect(await client.find(event.external_id, payload.schedule.localDate, null)).toBeNull()
  const first = await client.upsert(event)
  const next = await client.upsert({ ...event, start_date_local: '2027-03-22T00:00:00' })
  expect(next.id).toBe(first.id)
  expect(await client.find(event.external_id, payload.schedule.localDate, first.id)).toMatchObject({
    id: first.id,
    start_date_local: '2027-03-22T00:00:00',
  })
  assertIntervalsWorkoutExport(payload.workout, await client.exportFit(first.id))
  await client.cancel(first.id)
  await client.cancel(first.id)
  expect(await client.find(event.external_id, payload.schedule.localDate, first.id)).toBeNull()
  expect(provider.events.get('synthetic-client-key')?.size).toBe(0)
  expect(provider.calls.every((call) => !/activities|wellness/.test(call.path))).toBe(true)
})

it.each([
  [401, 'PERMISSION_REQUIRED'],
  [403, 'PERMISSION_REQUIRED'],
  [429, 'RATE_LIMITED'],
  [503, 'PROVIDER_UNAVAILABLE'],
])('redacts HTTP %s failures', async (status, code) => {
  const client = intervalsPublicationClient('synthetic-client-key', {
    fetcher: vi
      .fn()
      .mockResolvedValue(
        new Response('private credential or athlete data', { status: Number(status) }),
      ),
  })
  await expect(client.athleteId()).rejects.toMatchObject({
    code,
    message: 'Workout publication could not be completed',
  })
})

it('rejects malformed, oversized and challenged responses', async () => {
  for (const response of [
    new Response('{'),
    new Response('x'.repeat(1024 * 1024 + 1)),
    new Response('{}', { headers: { 'cf-mitigated': 'challenge' } }),
  ]) {
    const client = intervalsPublicationClient('synthetic-client-key', {
      fetcher: vi.fn().mockResolvedValue(response),
    })
    await expect(client.athleteId()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
  }
})

it('does not guess identity on an unrelated or duplicate provider event', async () => {
  const other = { id: 42, external_id: 'unrelated' }
  const client = intervalsPublicationClient('synthetic-client-key', {
    fetcher: vi.fn().mockResolvedValue(Response.json(other)),
  })
  await expect(client.find('ours', '2027-03-21', 42)).rejects.toMatchObject({
    code: 'REMOTE_CONFLICT',
  })
  const duplicate = intervalsPublicationClient('synthetic-client-key', {
    fetcher: vi.fn().mockResolvedValue(
      Response.json([
        { id: 1, external_id: 'ours' },
        { id: 2, external_id: 'ours' },
      ]),
    ),
  })
  await expect(duplicate.find('ours', '2027-03-21', null)).rejects.toMatchObject({
    code: 'REMOTE_CONFLICT',
  })
})

it('bounds a stalled real HTTP read without treating the timeout as remote absence', async () => {
  const provider = await publicationProviderFixture()
  closing.push(provider.close)
  provider.control.hangReads = true
  const client = intervalsPublicationClient('synthetic-client-key', {
    fetcher: provider.fetcher,
    timeoutMs: 40,
  })
  await expect(client.find('ours', '2027-03-21', null)).rejects.toMatchObject({
    code: 'PROVIDER_UNAVAILABLE',
  })
  expect(provider.calls.filter((call) => call.path === '/events')).toHaveLength(1)
})

it('recovers the stable external key after a saved numeric ID was deleted and recreated', async () => {
  const provider = await publicationProviderFixture()
  closing.push(provider.close)
  const client = intervalsPublicationClient('synthetic-client-key', { fetcher: provider.fetcher })
  const { userId, ...payload } = approvedPublicationFixture(randomUUID())
  const event = publicationMapping(payload, `running-coach:${userId}`).event
  const first = await client.upsert(event)
  await client.cancel(first.id)
  const recreated = await client.upsert(event)
  expect(recreated.id).not.toBe(first.id)

  const callStart = provider.calls.length
  expect(await client.find(event.external_id, payload.schedule.localDate, first.id)).toEqual(
    recreated,
  )
  expect(provider.calls.slice(callStart).map((call) => call.path)).toEqual([
    `/events/${first.id}`,
    '/events',
  ])
})

it('accepts nullable calendar fields without treating incomplete readback as a matching prescription', async () => {
  const { userId, ...payload } = approvedPublicationFixture(randomUUID())
  const wanted = publicationMapping(payload, `running-coach:${userId}`).event
  const event = { ...wanted, id: 42 }
  const client = intervalsPublicationClient('synthetic-client-key', {
    fetcher: vi.fn().mockResolvedValue(
      Response.json([
        {
          id: 987,
          external_id: null,
          category: null,
          type: null,
          target: null,
          name: null,
          description: null,
          start_date_local: null,
        },
        event,
      ]),
    ),
  })
  expect(await client.find(wanted.external_id, payload.schedule.localDate, null)).toEqual(event)
  expect(sameRemotePublication({ ...event, target: null }, wanted)).toBe(false)
  expect(sameRemotePublication({ ...event, description: null }, wanted)).toBe(false)
})

it.each([
  [401, 'PERMISSION_REQUIRED'],
  [403, 'PERMISSION_REQUIRED'],
  [429, 'RATE_LIMITED'],
  [503, 'PROVIDER_UNAVAILABLE'],
])(
  'does not fall back to an absence check after saved-ID lookup returns HTTP %s',
  async (status, code) => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: Number(status) }))
    const client = intervalsPublicationClient('synthetic-client-key', { fetcher })
    await expect(client.find('ours', '2027-03-21', 42)).rejects.toMatchObject({ code })
    expect(fetcher).toHaveBeenCalledOnce()
  },
)

it('rejects a saved-ID response with a different numeric identity even if its external key matches', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ id: 43, external_id: 'ours' }))
  const client = intervalsPublicationClient('synthetic-client-key', { fetcher })
  await expect(client.find('ours', '2027-03-21', 42)).rejects.toMatchObject({
    code: 'REMOTE_CONFLICT',
  })
  expect(fetcher).toHaveBeenCalledOnce()
})

it('sends only the verified numeric cancellation target and reads its absence independently of recreated events', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({}))
    .mockResolvedValueOnce(new Response('{}', { status: 404 }))
  const client = intervalsPublicationClient('synthetic-client-key', { fetcher })
  await client.cancel(42)
  expect(fetcher).toHaveBeenNthCalledWith(
    1,
    'https://intervals.icu/api/v1/athlete/0/events/bulk-delete',
    expect.objectContaining({ method: 'PUT', body: '[{"id":42}]' }),
  )
  expect(await client.isAbsent(42, 'ours')).toBe(true)
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it.each([401, 403, 429, 503])(
  'distinguishes definitive HTTP %s write rejection from uncertain server failure',
  async (status) => {
    const client = intervalsPublicationClient('synthetic-client-key', {
      fetcher: vi.fn().mockResolvedValue(new Response('{}', { status })),
    })
    await expect(client.cancel(42)).rejects.toMatchObject({ writeRejected: status !== 503 })
  },
)
