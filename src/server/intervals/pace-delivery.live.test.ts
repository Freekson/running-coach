import { config } from 'dotenv'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { WorkoutDefinition } from '@/schemas/workout-definition.v1'

vi.mock('server-only', () => ({}))
import { requestIntervalsPaceSettings } from './pace-client'
import {
  assertPaceReadback,
  compatiblePaceZones,
  INTERVALS_DELIVERY_REFERENCE,
  parseIntervalsRunSettings,
  type IntervalsRunSettings,
} from './pace-policy'
import { mapWorkoutToIntervals, type IntervalsWorkoutEvent } from './workout-mapping'
import { assertIntervalsWorkoutExport } from './workout-export'
import { intervalsPaceReferenceProbe } from './workout-mapping.fixtures'

// Explicit operator-only probe. Ordinary tests never load live keys or call providers.
const enabled = process.env.RUN40_INTERVALS_LIVE_PROBE === '1'
const keepWatchProbe = process.env.RUN40_KEEP_WATCH_PROBE === '1'
const externalId = 'running-coach:poc:reference-v1'
const eventSchema = z.object({ id: z.number().int().positive(), external_id: z.string() })

describe.skipIf(!enabled)('authorized Intervals.icu delivery reference probe', () => {
  let key: string
  let original: IntervalsRunSettings
  let retained = false
  let mutationStarted = false
  let matrixVerified = false
  let probeDate: string

  async function api(path: string, method = 'GET', body?: unknown): Promise<Uint8Array> {
    const response = await fetch(`https://intervals.icu/api/v1/athlete/0/${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`API_KEY:${key}`).toString('base64')}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Live delivery probe HTTP ${response.status}`)
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Empty probe response')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 1024 * 1024) {
          await reader.cancel()
          throw new Error('Oversized probe response')
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks)
  }

  async function publish(event: IntervalsWorkoutEvent, workout: WorkoutDefinition) {
    const raw = await api('events/bulk?upsert=true', 'POST', [event])
    const events = z.array(eventSchema).parse(JSON.parse(Buffer.from(raw).toString('utf8')))
    const own = events.filter((item) => item.external_id === externalId)
    expect(own).toHaveLength(1)
    const bytes = await api(`events/${own[0].id}/download.fit`)
    assertIntervalsWorkoutExport(workout, bytes)
    return own[0].id
  }

  beforeAll(async () => {
    const env = config({ path: '.env' }).parsed
    key = env?.INTERVALS_API_KEY ?? ''
    if (!key) throw new Error('Explicit live probe requires INTERVALS_API_KEY in .env')
    probeDate = z.iso.date().parse(process.env.RUN40_PROBE_DATE)
    original = parseIntervalsRunSettings(await requestIntervalsPaceSettings(key))
    // Never replace a pre-existing real/user reference just to run an experiment.
    if (original.threshold_pace || !compatiblePaceZones(original))
      throw new Error(
        'Live probe requires an unconfigured threshold and existing compatible zones; existing user settings were preserved',
      )
  })

  afterAll(async () => {
    if (!original || retained || !mutationStarted) return
    await api('events/bulk-delete', 'PUT', [{ external_id: externalId }])
    // Provider ignores null threshold updates; zero is its verified clear operation.
    await requestIntervalsPaceSettings(key, {
      patch: { threshold_pace: original.threshold_pace ?? 0 },
    })
    const restored = parseIntervalsRunSettings(await requestIntervalsPaceSettings(key))
    expect(restored.threshold_pace ?? 0).toBe(original.threshold_pace ?? 0)
    expect(restored.pace_zones).toEqual(original.pace_zones)
    expect(restored.pace_zone_names).toEqual(original.pace_zone_names)
  })

  it('preserves faster/slower absolute ranges with both 5:00 and 6:00 references', async () => {
    const workout: WorkoutDefinition = {
      schemaVersion: 1,
      name: 'Running Coach range matrix',
      sport: 'RUNNING',
      steps: [
        ...[
          [210, 240],
          [240, 270],
          [330, 360],
          [420, 450],
        ].map(([minSecondsPerKm, maxSecondsPerKm], index) => ({
          type: 'step' as const,
          termination:
            index % 2
              ? { type: 'time' as const, durationSeconds: 60 }
              : { type: 'distance' as const, distanceMeters: 400 },
          target: { type: 'pace' as const, minSecondsPerKm, maxSecondsPerKm },
        })),
      ],
    }
    let savedId: number | undefined
    for (const seconds of [300, 360]) {
      mutationStarted = true
      const patch = { threshold_pace: 1000 / seconds }
      await requestIntervalsPaceSettings(key, { patch })
      const readback = parseIntervalsRunSettings(await requestIntervalsPaceSettings(key))
      assertPaceReadback(original, readback, patch)
      const mapping = mapWorkoutToIntervals({
        workout: { ...workout, name: `${workout.name} ${seconds}` },
        externalId,
        schedule: { localDate: probeDate, timeZone: 'Asia/Tokyo' },
      })
      const id = await publish(mapping.event, workout)
      if (savedId !== undefined) expect(id).toBe(savedId)
      savedId = id
      console.info(
        JSON.stringify({
          probe: 'pace-matrix',
          referenceSecondsPerKm: seconds,
          rangesVerified: 4,
          mixedTimeDistance: true,
          sameStableEventId: true,
        }),
      )
    }
    matrixVerified = true
  }, 60_000)

  it('exports the representative nested workout using version-1 reference', async () => {
    if (!matrixVerified) throw new Error('Reference matrix must pass before keeping a watch probe')
    await requestIntervalsPaceSettings(key, {
      patch: { threshold_pace: INTERVALS_DELIVERY_REFERENCE.metersPerSecond },
    })
    const readback = parseIntervalsRunSettings(await requestIntervalsPaceSettings(key))
    assertPaceReadback(original, readback, {
      threshold_pace: INTERVALS_DELIVERY_REFERENCE.metersPerSecond,
    })
    const mapping = mapWorkoutToIntervals({
      workout: intervalsPaceReferenceProbe,
      expandNestedRepeats: true,
      externalId,
      schedule: { localDate: probeDate, timeZone: 'Asia/Tokyo' },
    })
    const id = await publish(mapping.event, intervalsPaceReferenceProbe)
    retained = keepWatchProbe
    console.info(
      JSON.stringify({
        probe: 'reference-watch',
        eventId: id,
        referenceVersion: INTERVALS_DELIVERY_REFERENCE.version,
        localDate: probeDate,
        targets: ['4:00-4:30/km', '5:30-6:00/km'],
        retainedForPhysicalVerification: retained,
        originalThresholdWasMissing: !original.threshold_pace,
      }),
    )
  }, 60_000)
})
