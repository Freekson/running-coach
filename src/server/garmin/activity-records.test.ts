import { expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { normalizeActivityRecords } from './activity-records'
import { recordsFit, recordsStart } from './activity-records.fixtures'
import { zipFixture, syntheticMultisportFit } from './fit-test-fixtures'
const identity = {
  startedAt: recordsStart,
  distanceMeters: 4000,
  elapsedMs: 1200_000,
  sport: 'RUNNING',
}

it('reads standalone session time-in-zone messages while preserving below-zone-zero indexing', () => {
  const zones = [40, 100, 600, 300, 100, 40]
  const bytes = recordsFit({
    sessionZones: [],
    zoneMessages: [{ referenceMesg: 'session', referenceIndex: 0, timeInHrZone: zones }],
  })
  expect(normalizeActivityRecords(bytes, identity).session.heartRateZoneSeconds).toEqual(zones)
})

it.each([
  [{ referenceMesg: 'lap' as const, referenceIndex: 0, timeInHrZone: [0, 300] }],
  [{ referenceMesg: 'session' as const, referenceIndex: 1, timeInHrZone: [0, 300] }],
  [{ referenceMesg: 'session' as const, referenceIndex: 0, timeInHrZone: [0, 5000] }],
  [
    { referenceMesg: 'session' as const, referenceIndex: 0, timeInHrZone: [0, 300] },
    { referenceMesg: 'session' as const, referenceIndex: 0, timeInHrZone: [0, 400] },
  ],
])('rejects mismatched, impossible or ambiguous standalone zones: %j', (...zoneMessages) => {
  expect(
    normalizeActivityRecords(recordsFit({ sessionZones: [], zoneMessages }), identity).session
      .heartRateZoneSeconds,
  ).toEqual([])
})

it('prefers valid session durations over a separate zone message', () => {
  const bytes = recordsFit({
    zoneMessages: [{ referenceMesg: 'session', referenceIndex: 0, timeInHrZone: [0, 200] }],
  })
  expect(normalizeActivityRecords(bytes, identity).session.heartRateZoneSeconds).toEqual([
    0, 100, 700, 300, 80, 0,
  ])
})

it.each(['FIT', 'ZIP'])(
  'decodes %s in SI units, preserves UTC and converts cadence and semicircles',
  (format) => {
    const bytes = recordsFit()
    const data = normalizeActivityRecords(
      format === 'ZIP' ? zipFixture([{ name: 'activity.fit', bytes }]) : bytes,
      identity,
    )
    expect(data.samples).toHaveLength(121)
    expect(data.startedAt).toBe(recordsStart.replace('Z', '.000Z'))
    expect(data.sampleIntervalSeconds).toBe(10)
    expect(data.samples[0]).toMatchObject({
      timeSeconds: 0,
      distanceMeters: 0,
      heartRateBpm: 140,
      cadence: 160,
      speedMps: 3.5,
      elevationMeters: 40,
      powerWatts: 230,
    })
    expect(data.samples[0].latitude).toBeCloseTo(40, 5)
    expect(data.samples[0].longitude).toBeCloseTo(10, 5)
    expect(data.session).toMatchObject({
      avgPowerWatts: 230,
      aerobicTrainingEffect: 3.3,
      heartRateZoneSeconds: [0, 100, 700, 300, 80, 0],
    })
  },
)
it('does not fabricate unsupported measurements or GPS and uses cycle cadence for cycling', () => {
  const empty = normalizeActivityRecords(recordsFit({ gps: false, metrics: false }), identity)
  expect(empty.samples[0]).toMatchObject({
    latitude: null,
    longitude: null,
    heartRateBpm: null,
    speedMps: null,
    cadence: null,
    powerWatts: null,
  })
  const cycling = normalizeActivityRecords(recordsFit({ sport: 'cycling' }), {
    ...identity,
    sport: 'CYCLING',
  })
  expect(cycling.cadenceUnit).toBe('rpm')
  expect(cycling.samples[0].cadence).toBe(80)
})
it('rejects an activity mismatch, corruption, unsafe archive and oversized download', () => {
  const bytes = recordsFit()
  expect(() =>
    normalizeActivityRecords(bytes, { ...identity, startedAt: '2026-11-09T08:00:00Z' }),
  ).toThrow()
  expect(() => normalizeActivityRecords(bytes, { ...identity, distanceMeters: 5000 })).toThrow()
  expect(() => normalizeActivityRecords(bytes, { ...identity, elapsedMs: 3600_000 })).toThrow()
  expect(() => normalizeActivityRecords(Buffer.from('invalid'), identity)).toThrow()
  expect(() =>
    normalizeActivityRecords(zipFixture([{ name: '../activity.fit', bytes }]), identity),
  ).toThrow()
  expect(() => normalizeActivityRecords(Buffer.alloc(8 * 1024 * 1024 + 1), identity)).toThrow()
})
it('bounds output size and preserves first/last points', () => {
  const data = normalizeActivityRecords(recordsFit({ count: 6001, elapsedSeconds: 6000 }), {
    ...identity,
    elapsedMs: 6000_000,
  })
  expect(data.sourceSampleCount).toBeGreaterThan(4000)
  expect(data.samples.length).toBeLessThanOrEqual(4000)
  expect(data.samples).toHaveLength(4000)
  expect(data.samples[0].timeSeconds).toBe(0)
  expect(data.samples.at(-1)?.timeSeconds).toBe(6000)
})

it('preserves skipped sensor/GPS gaps and recording breaks when reducing samples', () => {
  const start = Date.parse(recordsStart)
  const records = Array.from({ length: 6001 }, (_, index) => ({
    timestamp: new Date(start + (index + (index >= 3000 ? 45 : 0)) * 1000),
    heartRate: index === 2 ? undefined : 140,
    enhancedSpeed: 3.5,
    positionLat: index === 2 ? undefined : 1000000,
    positionLong: index === 2 ? undefined : 2000000,
  }))
  const data = normalizeActivityRecords(recordsFit({ records, elapsedSeconds: 6045 }), {
    ...identity,
    elapsedMs: 6045000,
  })
  const afterSensorGap = data.samples.find((sample) => sample.timeSeconds === 3)!
  expect(afterSensorGap.breakBefore).toEqual(expect.arrayContaining(['heartRateBpm', 'position']))
  expect(afterSensorGap.breakBefore).not.toContain('speedMps')
  const afterRecordingGap = data.samples.find((sample) => sample.timeSeconds >= 3045)!
  expect(afterRecordingGap.breakBefore).toHaveLength(6)
  expect(data.samples[0].timeSeconds).toBe(0)
  expect(data.samples.at(-1)?.timeSeconds).toBe(6045)
})
it('keeps valid records ordered, omits out-of-session points and removes duplicate timestamps', () => {
  const start = Date.parse(recordsStart)
  const bytes = recordsFit({
    records: [
      { timestamp: new Date(start + 20_000), heartRate: 150 },
      { timestamp: new Date(start - 1000), heartRate: 99 },
      { timestamp: new Date(start + 10_000), heartRate: 140 },
      { timestamp: new Date(start + 10_000), heartRate: 141 },
    ],
  })
  expect(
    normalizeActivityRecords(bytes, identity).samples.map((point) => point.timeSeconds),
  ).toEqual([10, 20])
})
it('does not assign one session training effect to a multisport workout', () => {
  const data = normalizeActivityRecords(syntheticMultisportFit(), {
    ...identity,
    distanceMeters: 1000,
    sport: 'OTHER',
  })
  expect(data.session.avgPowerWatts).toBeNull()
  expect(data.session.heartRateZoneSeconds).toEqual([])
})

it.each(['FIT', 'ZIP'])(
  'coalesces complementary %s measurements at the same timestamp',
  (format) => {
    const start = Date.parse(recordsStart)
    const bytes = recordsFit({
      records: [
        { timestamp: new Date(start + 10_000), heartRate: 150 },
        { timestamp: new Date(start), heartRate: 140 },
        { timestamp: new Date(start), power: 200, enhancedSpeed: 3 },
        { timestamp: new Date(start + 10_000), power: 220, enhancedSpeed: 3.5 },
      ],
    })
    const data = normalizeActivityRecords(
      format === 'ZIP' ? zipFixture([{ name: 'activity.fit', bytes }]) : bytes,
      identity,
    )
    expect(
      data.samples.map((sample) => [
        sample.timeSeconds,
        sample.heartRateBpm,
        sample.powerWatts,
        sample.speedMps,
      ]),
    ).toEqual([
      [0, 140, 200, 3],
      [10, 150, 220, 3.5],
    ])
    expect(data.sourceSampleCount).toBe(2)
    expect(data.sampleIntervalSeconds).toBe(10)
  },
)

it('keeps the first valid measurement including zero and the first complete GPS pair', () => {
  const timestamp = new Date(recordsStart)
  const data = normalizeActivityRecords(
    recordsFit({
      records: [
        {
          timestamp,
          heartRate: 140,
          distance: 0,
          enhancedSpeed: 0,
          power: 0,
          cadence: 0,
          enhancedAltitude: 0,
          positionLat: 123456,
        },
        {
          timestamp,
          heartRate: 150,
          distance: 100,
          enhancedSpeed: 3,
          power: 200,
          cadence: 80,
          fractionalCadence: 0.5,
          enhancedAltitude: 40,
          positionLat: 0,
          positionLong: 0,
        },
        { timestamp, positionLat: 999999, positionLong: 888888 },
      ],
    }),
    identity,
  )
  expect(data.samples).toHaveLength(1)
  expect(data.samples[0]).toMatchObject({
    heartRateBpm: 140,
    distanceMeters: 0,
    speedMps: 0,
    powerWatts: 0,
    cadence: 0,
    elevationMeters: 0,
    latitude: 0,
    longitude: 0,
  })
})
