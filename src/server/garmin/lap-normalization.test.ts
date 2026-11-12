import { describe, expect, it, vi } from 'vitest'
import { syntheticActivityFit, syntheticMultisportFit, zipFixture } from './fit-test-fixtures'

vi.mock('server-only', () => ({}))
import { decodeFitDownload } from './fit-probe'
import { normalizeFitLaps } from './normalization'

const startedAt = '2026-11-08T08:00:00Z'
const options = { allowMissingDistance: true, allowConfirmedEmpty: true }

describe('normalized FIT laps', () => {
  it('keeps a confirmed zero-lap session alongside another session with laps', () => {
    const laps = normalizeFitLaps(syntheticMultisportFit(), startedAt, 1000, 1_200_000, options)
    expect(laps).toHaveLength(1)
    expect(laps?.[0]).toMatchObject({
      lapIndex: 0,
      startedAt: '2026-11-08T08:10:00.000Z',
      endedAt: '2026-11-08T08:20:00.000Z',
      distanceMeters: 1000,
      elapsedMs: 600_000,
    })
  })

  it('assigns a short boundary lap to the session with laps rather than its zero-lap neighbour', () => {
    const laps = normalizeFitLaps(
      syntheticMultisportFit({ secondElapsedSeconds: 1 }),
      startedAt,
      1000,
      601_000,
      options,
    )
    expect(laps).toHaveLength(1)
    expect(laps?.[0]).toMatchObject({
      startedAt: '2026-11-08T08:10:00.000Z',
      endedAt: '2026-11-08T08:10:01.000Z',
      elapsedMs: 1000,
    })
  })

  it('rejects missing session coverage without explicit zero-lap confirmation', () => {
    expect(() =>
      normalizeFitLaps(
        syntheticMultisportFit({ firstSessionLapCount: null }),
        startedAt,
        1000,
        1_200_000,
        options,
      ),
    ).toThrow('FIT laps do not cover session duration')
  })

  it('rejects a zero-lap declaration that contradicts actual lap messages', () => {
    expect(() =>
      normalizeFitLaps(
        syntheticMultisportFit({ includeFirstLap: true }),
        startedAt,
        1000,
        1_200_000,
        options,
      ),
    ).toThrow('FIT lap count does not match its session')
  })

  it.each(['start', 'before_start', 'after_end'] as const)(
    'uses elapsed durations when FIT summary timestamps are %s',
    (summaryTimestamp) => {
      const baseline = normalizeFitLaps(syntheticActivityFit(), startedAt, 4000, 1_200_000, options)
      const laps = normalizeFitLaps(
        syntheticActivityFit({ summaryTimestamp, summaryFirst: true }),
        startedAt,
        4000,
        1_200_000,
        options,
      )
      expect(laps).toEqual(baseline)
      expect(laps?.[3].endedAt).toBe('2026-11-08T08:20:00.000Z')
    },
  )

  it('orders four running laps and preserves elapsed/timer, HR, speed, power, cadence and elevation', () => {
    const laps = normalizeFitLaps(
      syntheticActivityFit({ reverse: true }),
      startedAt,
      4000,
      1_200_000,
      options,
    )!
    expect(laps).toHaveLength(4)
    expect(laps.map((lap) => lap.lapIndex)).toEqual([0, 1, 2, 3])
    expect(laps[0]).toMatchObject({
      startedAt: '2026-11-08T08:00:00.000Z',
      endedAt: '2026-11-08T08:05:00.000Z',
      distanceMeters: 1000,
      elapsedMs: 300_000,
      timerMs: 290_000,
      movingMs: null,
      avgHrBpm: 145,
      maxHrBpm: 170,
      avgSpeedMps: 3.333,
      maxSpeedMps: 4.5,
      avgPowerWatts: 230,
      maxPowerWatts: 300,
      elevationGainMeters: 12,
      elevationLossMeters: 9,
      cadenceCyclesPerMinute: 80.5,
      cadenceStepsPerMinute: null,
    })
    expect(JSON.stringify(laps)).not.toMatch(/positionLat|positionLong|recordMesgs|654321/)
  })

  it.each(['cycling', 'walking', 'swimming', 'training'] as const)(
    'handles %s without running-only assumptions',
    (sport) => {
      const laps = normalizeFitLaps(
        syntheticActivityFit({ sport, metrics: false, distance: false }),
        startedAt,
        null,
        1_200_000,
        options,
      )!
      expect(laps).toHaveLength(4)
      expect(laps[0]).toMatchObject({
        distanceMeters: null,
        avgHrBpm: null,
        maxHrBpm: null,
        avgSpeedMps: null,
        avgPowerWatts: null,
        maxPowerWatts: null,
        cadenceCyclesPerMinute: null,
        cadenceStepsPerMinute: null,
        elevationGainMeters: null,
        movingMs: null,
      })
    },
  )

  it('distinguishes explicitly confirmed zero laps from missing lap data', () => {
    expect(normalizeFitLaps(syntheticActivityFit({ laps: 0 }), startedAt, 0, 0, options)).toEqual(
      [],
    )
    expect(
      normalizeFitLaps(
        syntheticActivityFit({ laps: 0, declaredLaps: 4 }),
        startedAt,
        0,
        0,
        options,
      ),
    ).toBeNull()
  })
})

describe('bounded binary validation', () => {
  it.each([0, 8] as const)(
    'finds FIT content independently of filename with ZIP method %s',
    (method) => {
      const bytes = zipFixture([{ name: 'session.data', bytes: syntheticActivityFit() }], method)
      expect(decodeFitDownload(bytes).messages.lapMesgs).toHaveLength(4)
    },
  )

  it.each([
    '../activity.fit',
    '/activity.fit',
    'C:/activity.fit',
    'folder\\activity.fit',
    'folder/../activity.fit',
    'bad\0.fit',
  ])('rejects unsafe ZIP path %j', (name) => {
    expect(() => decodeFitDownload(zipFixture([{ name, bytes: syntheticActivityFit() }]))).toThrow()
  })

  it('rejects ambiguous entries, excessive entries, compressed/decompressed bombs and malformed content', () => {
    const fit = syntheticActivityFit()
    expect(() =>
      decodeFitDownload(
        zipFixture([
          { name: 'a.fit', bytes: fit },
          { name: 'b.fit', bytes: fit },
        ]),
      ),
    ).toThrow('Ambiguous')
    expect(() =>
      decodeFitDownload(
        zipFixture(
          Array.from({ length: 33 }, (_, index) => ({ name: `${index}.fit`, bytes: fit })),
        ),
      ),
    ).toThrow()
    expect(() => decodeFitDownload(Buffer.alloc(8 * 1024 * 1024 + 1))).toThrow()
    expect(() =>
      decodeFitDownload(
        zipFixture([{ name: 'bomb.fit', bytes: Buffer.alloc(8 * 1024 * 1024 + 1) }]),
      ),
    ).toThrow()
    expect(() => decodeFitDownload(Buffer.from('<html>private error</html>'))).toThrow()
  })

  it('rejects encrypted/multi-disk ZIPs, mismatched headers and bad ZIP CRC', () => {
    const original = zipFixture([{ name: 'a.fit', bytes: syntheticActivityFit() }])
    const directory = original.readUInt32LE(original.length - 6)
    for (const mutate of [
      (bytes: Buffer) => bytes.writeUInt16LE(1, directory + 8),
      (bytes: Buffer) => bytes.writeUInt16LE(1, bytes.length - 18),
      (bytes: Buffer) => bytes.writeUInt16LE(0, 8),
      (bytes: Buffer) => {
        bytes.writeUInt32LE(123, directory + 16)
        bytes.writeUInt32LE(123, 14)
      },
    ]) {
      const bytes = Buffer.from(original)
      mutate(bytes)
      expect(() => decodeFitDownload(bytes)).toThrow()
    }
  })

  it('rejects truncated/trailing/corrupt FIT bytes and expired decode budgets', () => {
    const fit = syntheticActivityFit()
    expect(() => decodeFitDownload(fit.subarray(0, fit.length - 1))).toThrow()
    expect(() => decodeFitDownload(Buffer.concat([fit, Buffer.from('trailing')]))).toThrow()
    const corrupt = Buffer.from(fit)
    corrupt[20] ^= 0xff
    expect(() => decodeFitDownload(corrupt)).toThrow()
    expect(() => decodeFitDownload(fit, Date.now() - 1)).toThrow()
  })
})
