import 'server-only'

import { apiKeySchema } from '@/server/provider/vault'
import { IntervalsPaceError, type IntervalsPacePatch } from './pace-policy'

export async function requestIntervalsPaceSettings(
  key: string,
  options: { fetcher?: typeof fetch; timeoutMs?: number; patch?: IntervalsPacePatch } = {},
): Promise<unknown> {
  if (!apiKeySchema.safeParse(key).success) throw new IntervalsPaceError('INVALID_KEY')
  const writing = options.patch !== undefined
  const url = `https://intervals.icu/api/v1/athlete/0/sport-settings${writing ? '/Run?recalcHrZones=false' : ''}`
  try {
    const response = await (options.fetcher ?? fetch)(url, {
      method: writing ? 'PUT' : 'GET',
      headers: {
        Authorization: `Basic ${Buffer.from(`API_KEY:${key}`).toString('base64')}`,
        Accept: 'application/json',
        ...(writing ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(writing ? { body: JSON.stringify(options.patch) } : {}),
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
      throw new IntervalsPaceError('PROVIDER_UNAVAILABLE')
    }
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 401) throw new IntervalsPaceError('INVALID_KEY')
      if (response.status === 403) throw new IntervalsPaceError('PERMISSION_REQUIRED')
      if (response.status === 429) throw new IntervalsPaceError('RATE_LIMITED')
      if (response.status === 422) throw new IntervalsPaceError('CONFIGURATION_CONFLICT')
      throw new IntervalsPaceError('PROVIDER_UNAVAILABLE')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new IntervalsPaceError('PROVIDER_UNAVAILABLE')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 512 * 1024) {
          await reader.cancel()
          throw new IntervalsPaceError('PROVIDER_UNAVAILABLE')
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return result
  } catch (error) {
    if (error instanceof IntervalsPaceError) throw error
    throw new IntervalsPaceError('PROVIDER_UNAVAILABLE')
  }
}
