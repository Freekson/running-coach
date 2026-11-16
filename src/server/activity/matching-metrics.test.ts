import { Prisma } from '@prisma/client'
import { expect, it, vi } from 'vitest'
import { definitionFixture } from '@/server/plans/fixtures'
import { matchingMetrics, matchCandidate } from './matching-metrics'

vi.mock('server-only', () => ({}))
const actual = matchingMetrics({
  distanceMeters: new Prisma.Decimal(5000),
  timerMs: BigInt(1800000),
  avgHrBpm: 145,
  maxHrBpm: null,
})
const member = {
  workoutId: 'workout',
  planId: 'plan',
  revisionId: 'revision',
  scheduledDate: new Date('2026-11-15'),
  timezone: 'America/Los_Angeles',
  definition: definitionFixture,
}
it('uses saved timer seconds and meters for pace and keeps missing metrics null', () => {
  expect(actual).toMatchObject({
    distanceMeters: 5000,
    durationSeconds: 1800,
    paceSecondsPerKm: 360,
    maxHrBpm: null,
  })
  expect(
    matchingMetrics({ distanceMeters: null, timerMs: null, avgHrBpm: null, maxHrBpm: null }),
  ).toEqual({
    distanceMeters: null,
    durationSeconds: null,
    durationBasis: 'unavailable',
    paceSecondsPerKm: null,
    paceBasis: 'unavailable',
    avgHrBpm: null,
    maxHrBpm: null,
  })
  expect(
    matchingMetrics({
      distanceMeters: new Prisma.Decimal(0),
      timerMs: BigInt(0),
      avgHrBpm: null,
      maxHrBpm: null,
    }).paceSecondsPerKm,
  ).toBeNull()
})
it('compares dates in the scheduled timezone across UTC midnight and DST', () => {
  const candidate = matchCandidate(member, {
    startedAt: new Date('2026-11-16T07:30:00Z'),
    sportType: 'RUNNING',
    metrics: actual,
  })
  expect(candidate.sameLocalDate).toBe(true)
  expect(candidate.metricAgreement).toBe(true)
  expect(candidate.estimate.distanceMeters.incomplete).toBe(true)
  expect(candidate.paceSecondsPerKm).toBeNull()
})
it('does not claim agreement for sparse, incompatible or substantially different metrics', () => {
  for (const source of [
    { sportType: 'CYCLING', metrics: actual },
    { sportType: 'RUNNING', metrics: { ...actual, durationSeconds: null } },
    { sportType: 'RUNNING', metrics: { ...actual, durationSeconds: 6000 } },
  ])
    expect(matchCandidate(member, { ...source, startedAt: new Date() }).metricAgreement).toBe(false)
})
it('retains repeat estimates and explicit step target envelopes without inventing averages', () => {
  const candidate = matchCandidate(
    {
      ...member,
      definition: {
        ...definitionFixture,
        steps: [
          {
            type: 'repeat',
            count: 2,
            steps: [
              {
                type: 'step',
                termination: { type: 'distance', distanceMeters: 1000 },
                target: { type: 'pace', minSecondsPerKm: 300, maxSecondsPerKm: 360 },
              },
            ],
          },
        ],
      },
    },
    { startedAt: new Date(), sportType: 'RUNNING', metrics: actual },
  )
  expect(candidate.estimate.distanceMeters).toEqual({ min: 2000, max: 2000, incomplete: false })
  expect(candidate.estimate.durationSeconds).toEqual({ min: 600, max: 720, incomplete: false })
  expect(candidate.paceSecondsPerKm).toEqual({ min: 300, max: 360 })
})
it('uses recorded speed for sparse pace without inventing timer time or distance', () => {
  expect(
    matchingMetrics({
      distanceMeters: null,
      timerMs: null,
      avgSpeedMps: new Prisma.Decimal(3),
      avgHrBpm: null,
      maxHrBpm: null,
    }),
  ).toMatchObject({
    distanceMeters: null,
    durationSeconds: null,
    durationBasis: 'unavailable',
    paceSecondsPerKm: 1000 / 3,
    paceBasis: 'recorded-speed',
  })
})
it('keeps timer-distance pace authoritative when both sources exist and rejects zero speed', () => {
  expect(
    matchingMetrics({
      distanceMeters: new Prisma.Decimal(5000),
      timerMs: BigInt(1800000),
      avgSpeedMps: new Prisma.Decimal(5),
      avgHrBpm: null,
      maxHrBpm: null,
    }),
  ).toMatchObject({ paceSecondsPerKm: 360, paceBasis: 'timer-distance' })
  expect(
    matchingMetrics({
      distanceMeters: null,
      timerMs: null,
      avgSpeedMps: new Prisma.Decimal(0),
      avgHrBpm: null,
      maxHrBpm: null,
    }),
  ).toMatchObject({ paceSecondsPerKm: null, paceBasis: 'unavailable' })
})
