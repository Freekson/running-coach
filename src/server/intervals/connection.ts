import 'server-only'

import { z } from 'zod'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import {
  apiKeySchema,
  beginProviderApiKeyWrite,
  getProviderConnectionStatus,
  readProviderApiKeySnapshot,
  recordProviderApiKeyAccess,
  saveProviderApiKey,
} from '@/server/provider/vault'

export class IntervalsConnectionError extends Error {
  constructor(readonly code: 'INVALID_KEY' | 'RATE_LIMITED' | 'PROVIDER_UNAVAILABLE') {
    super('Intervals.icu connection could not be verified')
  }
}

// Calendar access is sufficient for outbound workouts. Never probe activities or wellness.
const calendarSchema = z.array(z.object({ id: z.union([z.string().min(1), z.number().int()]) }))

export async function verifyIntervalsApiKey(
  rawKey: string,
  options: { fetcher?: typeof fetch; now?: Date; timeoutMs?: number } = {},
): Promise<void> {
  const parsed = apiKeySchema.safeParse(rawKey)
  if (!parsed.success) throw new IntervalsConnectionError('INVALID_KEY')
  const date = (options.now ?? new Date()).toISOString().slice(0, 10)
  const url = new URL('https://intervals.icu/api/v1/athlete/0/events')
  url.search = new URLSearchParams({ oldest: date, newest: date, category: 'WORKOUT' }).toString()
  try {
    const response = await (options.fetcher ?? fetch)(url, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${Buffer.from(`API_KEY:${parsed.data}`).toString('base64')}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    })
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    if (
      response.headers.get('cf-mitigated') === 'challenge' ||
      contentType === 'text/html' ||
      contentType === 'application/xhtml+xml'
    ) {
      await response.body?.cancel()
      throw new IntervalsConnectionError('PROVIDER_UNAVAILABLE')
    }
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 401 || response.status === 403)
        throw new IntervalsConnectionError('INVALID_KEY')
      if (response.status === 429) throw new IntervalsConnectionError('RATE_LIMITED')
      throw new IntervalsConnectionError('PROVIDER_UNAVAILABLE')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new IntervalsConnectionError('PROVIDER_UNAVAILABLE')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 512 * 1024) {
          await reader.cancel()
          throw new IntervalsConnectionError('PROVIDER_UNAVAILABLE')
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!calendarSchema.safeParse(value).success)
      throw new IntervalsConnectionError('PROVIDER_UNAVAILABLE')
  } catch (error) {
    if (error instanceof IntervalsConnectionError) throw error
    // Never expose provider bodies, request headers or raw fetch errors.
    throw new IntervalsConnectionError('PROVIDER_UNAVAILABLE')
  }
}

export async function connectIntervals(owner: OwnerContext, apiKey: string) {
  ownerId(owner)
  if (!apiKeySchema.safeParse(apiKey).success) throw new IntervalsConnectionError('INVALID_KEY')
  const expectedConnectionVersion = await beginProviderApiKeyWrite(owner, 'INTERVALS')
  await verifyIntervalsApiKey(apiKey)
  return saveProviderApiKey(owner, 'INTERVALS', apiKey, { expectedConnectionVersion })
}

export async function testIntervalsConnection(owner: OwnerContext) {
  const snapshot = await readProviderApiKeySnapshot(owner, 'INTERVALS')
  try {
    await verifyIntervalsApiKey(snapshot.key)
  } catch (error) {
    if (error instanceof IntervalsConnectionError && error.code === 'INVALID_KEY')
      await recordProviderApiKeyAccess(owner, 'INTERVALS', snapshot.nonce, 'REJECTED')
    throw error
  }
  await recordProviderApiKeyAccess(owner, 'INTERVALS', snapshot.nonce, 'VERIFIED')
  return getProviderConnectionStatus(owner, 'INTERVALS')
}
