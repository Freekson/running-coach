import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import {
  assertPaceReadback,
  compatiblePaceZones,
  INTERVALS_DELIVERY_REFERENCE,
  missingIntervalsPaceSettings,
  parseIntervalsRunSettings,
} from './pace-policy'

const configured = {
  id: 123,
  types: ['Run', 'VirtualRun'],
  threshold_pace: 4,
  pace_zones: [80, 95, 105, 999],
  pace_zone_names: ['Easy', 'Steady', 'Fast', 'Other'],
}

it('preserves a valid custom threshold, zones and names without a patch', () => {
  const before = structuredClone(configured)
  expect(missingIntervalsPaceSettings(parseIntervalsRunSettings([configured]))).toEqual({})
  expect(configured).toEqual(before)
})

it('uses one versioned 5:00/km delivery reference and verified provider-default zones', () => {
  const patch = missingIntervalsPaceSettings(
    parseIntervalsRunSettings([{ id: 123, types: ['Run'] }]),
  )
  expect(patch).toEqual({
    threshold_pace: 1000 / 300,
    pace_zones: [...INTERVALS_DELIVERY_REFERENCE.zones],
    pace_zone_names: [...INTERVALS_DELIVERY_REFERENCE.zoneNames],
  })
  expect(INTERVALS_DELIVERY_REFERENCE.version).toBe(1)
})

it('adds only a missing threshold while retaining custom zones', () => {
  expect(missingIntervalsPaceSettings({ ...configured, threshold_pace: null })).toEqual({
    threshold_pace: 1000 / 300,
  })
})

it('adds only missing zones while retaining the existing threshold', () => {
  const patch = missingIntervalsPaceSettings({
    ...configured,
    pace_zones: null,
    pace_zone_names: null,
  })
  expect(patch).not.toHaveProperty('threshold_pace')
  expect(patch.pace_zones).toEqual([...INTERVALS_DELIVERY_REFERENCE.zones])
})

it.each(
  [
    [],
    [configured, configured],
    [{ ...configured, types: ['Ride'] }],
    [{ ...configured, threshold_pace: -1 }],
    [{ ...configured, threshold_pace: '3.3' }],
    [{ ...configured, pace_zones: [Number.NaN, 999] }],
  ].map((value) => ({ value })),
)('rejects malformed or ambiguous provider data: %#', ({ value }) => {
  expect(() => parseIntervalsRunSettings(value)).toThrow(
    expect.objectContaining({ code: 'CONFIGURATION_CONFLICT' }),
  )
})

describe('partial and custom configurations', () => {
  it.each([
    { ...configured, pace_zones: [90, 80, 999] },
    { ...configured, pace_zones: [0, 999] },
    { ...configured, pace_zones: [80, 100] },
    { ...configured, pace_zones: [999] },
    { ...configured, pace_zone_names: ['Custom orphan'] },
    { ...configured, pace_zones: null },
  ])('fails closed instead of replacing nonempty incompatible data: %#', (settings) => {
    expect(() => missingIntervalsPaceSettings(settings)).toThrow(
      expect.objectContaining({ code: 'CONFIGURATION_CONFLICT' }),
    )
  })
})

it('accepts float32 threshold readback but rejects rewritten prescriptions/settings', () => {
  const before = { id: 123, types: ['Run'] }
  const patch = missingIntervalsPaceSettings(before)
  const after = { ...before, ...patch, threshold_pace: 3.3333333 }
  expect(assertPaceReadback(before, after, patch)).toBeUndefined()
  for (const bad of [
    { ...after, threshold_pace: 4 },
    { ...after, pace_zones: [80, 999] },
    { ...after, id: 456 },
    { ...after, pace_zone_names: ['Wrong'] },
  ])
    expect(() => assertPaceReadback(before, bad, patch)).toThrow(
      expect.objectContaining({ code: 'READBACK_FAILED' }),
    )
  expect(compatiblePaceZones(configured)).toBe(true)
})
