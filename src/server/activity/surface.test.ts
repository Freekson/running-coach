import { expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { recordedActivitySurface } from './surface'

it.each([
  ['trail_running', 'TRAIL'],
  ['track_running', 'TRACK'],
  ['street_running', 'ROAD'],
  ['treadmill_running', 'TREADMILL'],
] as const)('recognizes the recorded Garmin subtype %s', (sourceSportType, surface) => {
  expect(
    recordedActivitySurface({
      sportType: 'RUNNING',
      sourceProvider: 'GARMIN',
      surfaceType: null,
      sourceSportType,
    }),
  ).toBe(surface)
})

it('does not guess generic running surfaces or apply Garmin mappings to another provider', () => {
  for (const sourceSportType of ['running', 'virtual_running', 'unknown', null])
    expect(
      recordedActivitySurface({ sportType: 'RUNNING', sourceProvider: 'GARMIN', sourceSportType }),
    ).toBeNull()
  expect(
    recordedActivitySurface({
      sportType: 'RUNNING',
      sourceProvider: 'MANUAL',
      sourceSportType: 'trail_running',
    }),
  ).toBeNull()
  expect(
    recordedActivitySurface({
      sportType: 'RUNNING',
      sourceProvider: 'MANUAL',
      sourceSportType: null,
      surfaceType: 'ROAD',
    }),
  ).toBe('ROAD')
})
