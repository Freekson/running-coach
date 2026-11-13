import { expect, it } from 'vitest'
import { chartsFixture } from './activity-detail.fixtures'
import { routeGeometry } from './route-geometry'
import type { ActivitySample } from '@/lib/activity-detail'

it('preserves a recording gap carried through display sampling', () => {
  const samples: ActivitySample[] = chartsFixture.samples.slice(0, 6).map((sample, index) => ({
    ...sample,
    timeSeconds: index * 50,
    ...(index === 3 ? { breakBefore: ['position'] } : {}),
  }))
  expect(routeGeometry(samples).lines.map((line) => line.length)).toEqual([3, 3])
})

it('fits a crossing of the date line locally instead of around the world', () => {
  const samples = [179.9, -179.9, -179.8].map((longitude, index) => ({
    ...chartsFixture.samples[index],
    longitude,
    latitude: 40,
  }))
  const route = routeGeometry(samples)
  expect(route.bounds![1][0] - route.bounds![0][0]).toBeCloseTo(0.3)
  expect(route.lines).toHaveLength(1)
})

it('does not invent a route across missing fixes or recording gaps', () => {
  const samples = chartsFixture.samples.slice(0, 8).map((sample, index) => ({
    ...sample,
    latitude: index === 2 ? null : sample.latitude,
    timeSeconds: sample.timeSeconds + (index >= 6 ? 300 : 0),
  }))
  expect(routeGeometry(samples).lines.map((line) => line.length)).toEqual([2, 3, 2])
  expect(routeGeometry([])).toEqual({ points: [], lines: [], bounds: null })
})
