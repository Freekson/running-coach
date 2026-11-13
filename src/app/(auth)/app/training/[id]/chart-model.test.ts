import { expect, it } from 'vitest'
import { chartValue, chartValueLabel, smoothValues } from './chart-model'
import { chartsFixture } from './activity-detail.fixtures'
import { activityDetailBackLink, type ActivitySample } from '@/lib/activity-detail'
it('converts recorded speed into running pace or cycling speed using explicit units', () => {
  const sample = { ...chartsFixture.samples[0], speedMps: 10 }
  expect(chartValue(sample, 'speedMps', true, 'METRIC')).toBe(100)
  expect(chartValue(sample, 'speedMps', false, 'METRIC')).toBe(36)
  expect(chartValueLabel(100, 'speedMps', true, false, 'spm')).toBe('1:40 /km')
  expect(chartValue({ ...sample, speedMps: 0 }, 'speedMps', true, 'METRIC')).toBeNull()
  expect(chartValue({ ...sample, speedMps: 0 }, 'speedMps', false, 'METRIC')).toBe(0)
  expect(
    chartValue({ ...sample, elevationMeters: -20 }, 'elevationMeters', false, 'IMPERIAL'),
  ).toBeCloseTo(-65.6168)
})
it('smooths only measured values and never fills nulls or long recording gaps', () => {
  const samples = [0, 1, 2, 3, 60].map((timeSeconds) => ({
    ...chartsFixture.samples[0],
    timeSeconds,
  }))
  expect(smoothValues(samples, [10, 20, null, 40, 80], 5)).toEqual([10, 15, null, 40, 80])
})
it('only permits a relative Training History return target', () => {
  expect(activityDetailBackLink('/app/training?page=2&q=Trail')).toBe(
    '/app/training?page=2&q=Trail',
  )
  for (const value of ['https://other.test', '//other.test', '/app/training/other', ['bad']])
    expect(activityDetailBackLink(value)).toBe('/app/training')
})

it('does not smooth through sensor gaps preserved during display sampling', () => {
  const samples: ActivitySample[] = [0, 2, 4].map((timeSeconds, index) => ({
    ...chartsFixture.samples[0],
    timeSeconds,
    ...(index === 1 ? { breakBefore: ['heartRateBpm'] } : {}),
  }))
  expect(smoothValues(samples, [10, 20, 30], 5, 'heartRateBpm')).toEqual([10, 20, 25])
  expect(smoothValues(samples, [10, 20, 30], 5, 'powerWatts')).toEqual([10, 15, 20])
})
