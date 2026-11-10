import { config } from 'dotenv'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
config({ path: '.env', override: false })

import { probeGarminHealthRange } from './personal-api-range-poc'

describe.skipIf(process.env.GARMIN_HEALTH_RANGE_POC !== '1')(
  'Garmin Personal API health range live PoC',
  () => {
    it('reports only redacted structure for two or three completed days', async () => {
      const key = process.env.GARMIN_API_KEY
      const start = process.env.GARMIN_HEALTH_RANGE_START
      const end = process.env.GARMIN_HEALTH_RANGE_END
      if (!key || !start || !end)
        throw new Error('Set GARMIN_API_KEY and GARMIN_HEALTH_RANGE_START/END in local .env')
      const report = await probeGarminHealthRange(key, start, end, true)
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      expect(report.requestCount).toBeLessThanOrEqual(3)
    }, 35_000)
  },
)
