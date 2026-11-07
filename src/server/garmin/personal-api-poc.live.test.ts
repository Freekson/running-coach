import { config } from 'dotenv'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
config({ path: '.env', override: false })

import { probeGarminPersonalApi } from './personal-api-poc'

describe.skipIf(process.env.GARMIN_LIVE_POC !== '1')('Garmin Personal API live PoC', () => {
  it('prints only bounded structural metadata from the configured personal account', async () => {
    const key = process.env.GARMIN_API_KEY
    if (!key) throw new Error('Set GARMIN_API_KEY in the saved repository-root .env file')
    const report = await probeGarminPersonalApi(key)
    // The report contains endpoint names, statuses and JSON field names/types only.
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    expect(report.results[0].status).toBe(200)
    expect(report.results.find((result) => result.endpoint === 'activities')?.status).toBe(200)
  }, 90_000)
})
