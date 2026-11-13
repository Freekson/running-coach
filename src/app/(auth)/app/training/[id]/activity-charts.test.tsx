import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { normalizeActivityRecords } from '@/server/garmin/activity-records'
import { recordsFit, recordsStart } from '@/server/garmin/activity-records.fixtures'
import { ActivityChartsPanel } from './activity-charts'
import { MeasurementSystemProvider } from '../../measurement-system-provider'

it('draws continuous traces after a long FIT recording is reduced to 4000 points', () => {
  const data = normalizeActivityRecords(recordsFit({ count: 20001, elapsedSeconds: 200000 }), {
    startedAt: recordsStart,
    distanceMeters: 4000,
    elapsedMs: 200000000,
    sport: 'RUNNING',
  })
  expect(data.samples).toHaveLength(4000)
  expect(data.sampleIntervalSeconds).toBe(10)
  const html = renderToStaticMarkup(
    <MeasurementSystemProvider initialSystem="METRIC">
      <ActivityChartsPanel data={data} sport="RUNNING" />
    </MeasurementSystemProvider>,
  )
  const path = html.match(/<svg[^>]*aria-label="Heart rate by time"[\s\S]*?<path d="([^"]+)"/)
  expect(path).not.toBeNull()
  expect(path![1].match(/M/g)).toHaveLength(1)
  expect(path![1]).toContain('L')
})
