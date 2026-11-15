import 'server-only'

import { z } from 'zod'
import { apiKeySchema } from '@/server/provider/vault'
import { PublicationError } from './publication-contract'
import type { IntervalsWorkoutEvent } from './workout-mapping'

export const remotePublicationEventSchema = z.object({
  id: z.number().int().positive(),
  external_id: z.string().nullable().optional(),
  tags: z.array(z.string()).nullish(),
  category: z.string().nullish(),
  type: z.string().nullish(),
  target: z.string().nullish(),
  name: z.string().nullish(),
  description: z.string().nullish(),
  start_date_local: z.string().nullish(),
})
export type RemotePublicationEvent = z.infer<typeof remotePublicationEventSchema>

export function sameRemotePublication(
  actual: RemotePublicationEvent,
  wanted: IntervalsWorkoutEvent,
) {
  return Object.entries(wanted).every(([key, value]) => Reflect.get(actual, key) === value)
}

export function intervalsPublicationClient(
  key: string,
  options: { fetcher?: typeof fetch; timeoutMs?: number } = {},
) {
  if (!apiKeySchema.safeParse(key).success) throw new PublicationError('PERMISSION_REQUIRED')
  async function request(path: string, method = 'GET', body?: unknown, missing = false) {
    try {
      const response = await (options.fetcher ?? fetch)(
        `https://intervals.icu/api/v1/athlete/0${path}`,
        {
          method,
          headers: {
            Authorization: `Basic ${Buffer.from(`API_KEY:${key}`).toString('base64')}`,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          cache: 'no-store',
          redirect: 'error',
          signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
        },
      )
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
      if (response.headers.get('cf-mitigated') === 'challenge' || contentType.includes('html')) {
        await response.body?.cancel()
        throw new PublicationError('PROVIDER_UNAVAILABLE')
      }
      if (missing && response.status === 404) {
        await response.body?.cancel()
        return null
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new PublicationError(
          response.status === 401 || response.status === 403
            ? 'PERMISSION_REQUIRED'
            : response.status === 429
              ? 'RATE_LIMITED'
              : 'PROVIDER_UNAVAILABLE',
          method !== 'GET' && [401, 403, 429].includes(response.status),
        )
      }
      const reader = response.body?.getReader()
      if (!reader) throw new PublicationError('PROVIDER_UNAVAILABLE')
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 1024 * 1024) {
            await reader.cancel()
            throw new PublicationError('PROVIDER_UNAVAILABLE')
          }
          chunks.push(value)
        }
      } finally {
        reader.releaseLock()
      }
      return Buffer.concat(chunks)
    } catch (error) {
      if (error instanceof PublicationError) throw error
      throw new PublicationError('PROVIDER_UNAVAILABLE')
    }
  }
  async function json(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    try {
      const bytes = await request(path, method, body)
      if (!bytes) throw new Error()
      return JSON.parse(bytes.toString('utf8'))
    } catch (error) {
      if (error instanceof PublicationError) throw error
      throw new PublicationError('PROVIDER_UNAVAILABLE')
    }
  }
  return {
    async athleteId() {
      const parsed = z
        .object({
          id: z
            .string()
            .min(1)
            .max(64)
            .regex(/^[A-Za-z0-9_-]+$/),
        })
        .safeParse(await json(''))
      if (!parsed.success) throw new PublicationError('PROVIDER_UNAVAILABLE')
      return parsed.data.id
    },
    async find(
      externalId: string,
      localDate: string,
      remoteId: number | null,
    ): Promise<RemotePublicationEvent | null> {
      try {
        if (remoteId !== null) {
          const bytes = await request(`/events/${remoteId}`, 'GET', undefined, true)
          if (bytes) {
            const event = remotePublicationEventSchema.parse(JSON.parse(bytes.toString('utf8')))
            if (event.id !== remoteId || event.external_id !== externalId)
              throw new PublicationError('REMOTE_CONFLICT')
            return event
          }
          // A cancelled event may have been recreated before its new ID was saved.
          // A stale numeric ID's 404 does not establish absence of the stable key.
        }
        const query = new URLSearchParams({
          oldest: localDate,
          newest: localDate,
          category: 'WORKOUT',
        })
        const events = z.array(remotePublicationEventSchema).parse(await json(`/events?${query}`))
        const matches = events.filter((event) => event.external_id === externalId)
        if (matches.length > 1) throw new PublicationError('REMOTE_CONFLICT')
        return matches[0] ?? null
      } catch (error) {
        if (error instanceof PublicationError) throw error
        throw new PublicationError('REMOTE_CONFLICT')
      }
    },
    async upsert(event: IntervalsWorkoutEvent & { tags?: string[] }) {
      const result = z
        .array(remotePublicationEventSchema)
        .safeParse(await json('/events/bulk?upsert=true', 'POST', [event]))
      if (
        !result.success ||
        result.data.length !== 1 ||
        result.data[0].external_id !== event.external_id
      )
        throw new PublicationError('REMOTE_CONFLICT')
      return result.data[0]
    },
    async cancel(remoteEventId: number) {
      // A late cancellation must never remove a later recreated event.
      await request('/events/bulk-delete', 'PUT', [{ id: remoteEventId }])
    },
    async isAbsent(remoteEventId: number, externalId: string) {
      const bytes = await request(`/events/${remoteEventId}`, 'GET', undefined, true)
      if (!bytes) return true
      try {
        const event = remotePublicationEventSchema.parse(JSON.parse(bytes.toString('utf8')))
        if (event.id !== remoteEventId || event.external_id !== externalId) throw new Error()
        return false
      } catch {
        throw new PublicationError('REMOTE_CONFLICT')
      }
    },
    async exportFit(id: number) {
      const bytes = await request(`/events/${id}/download.fit`)
      if (!bytes) throw new PublicationError('EXPORT_UNVERIFIED')
      return bytes
    },
  }
}
