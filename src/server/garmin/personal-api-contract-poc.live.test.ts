import { config } from 'dotenv'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
config({ path: '.env', override: false })

import { probeGarminDataContracts } from './personal-api-poc'

describe.skipIf(process.env.GARMIN_CONTRACT_POC !== '1')('Garmin data contract live PoC', () => {
  it('reports only bounded structure from the configured personal account', async () => {
    const key = process.env.GARMIN_API_KEY
    if (!key) throw new Error('Set GARMIN_API_KEY in the saved repository-root .env file')
    const report = await probeGarminDataContracts(key)
    // The report contains endpoint statuses, field names/types and structural booleans only.
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    expect(report.results[0].status).toBe(200)
    expect(report.results.find((result) => result.endpoint === 'recent-activity')?.status).toBe(200)
  }, 90_000)
})
