import type { ActivityMatchingData, MatchCandidate } from '@/lib/activity-matching'

export function matchingFixture(): ActivityMatchingData {
  const candidate: MatchCandidate = {
    workoutId: '10000000-0000-4000-8000-000000000001',
    planId: '10000000-0000-4000-8000-000000000002',
    revisionId: '10000000-0000-4000-8000-000000000003',
    name: 'Easy endurance run',
    sport: 'RUNNING',
    date: '2026-11-16',
    timezone: 'Asia/Tokyo',
    estimate: {
      distanceMeters: { min: 5000, max: 6000, incomplete: false },
      durationSeconds: { min: 1800, max: 1800, incomplete: false },
      stepCount: 1,
    },
    paceSecondsPerKm: { min: 300, max: 360 },
    heartRateTargetBpm: null,
    sameLocalDate: true,
    metricAgreement: true,
  }
  return {
    activityId: '10000000-0000-4000-8000-000000000004',
    title: 'Morning run',
    sport: 'RUNNING',
    startedAt: '2026-11-15T23:30:00.000Z',
    localDate: '2026-11-16',
    timezone: 'Asia/Tokyo',
    sourceRecordType: 'API_ACTIVITY',
    externalActivityId: '12345',
    importedAt: '2026-11-16T02:00:00.000Z',
    actual: {
      distanceMeters: 5200,
      durationSeconds: 1800,
      durationBasis: 'timer',
      paceSecondsPerKm: 346.15,
      paceBasis: 'timer-distance',
      avgHrBpm: 145,
      maxHrBpm: null,
    },
    laps: [
      {
        index: 0,
        sourceRecordType: 'FIT_LAP',
        distanceMeters: 1000,
        durationSeconds: 340,
        durationBasis: 'timer',
        paceSecondsPerKm: 340,
        paceBasis: 'timer-distance',
        avgHrBpm: 142,
        maxHrBpm: null,
      },
    ],
    searchDate: '2026-11-16',
    candidates: [candidate],
    suggestionWorkoutId: candidate.workoutId,
    ambiguous: false,
    duplicateCount: 0,
    duplicateLinked: false,
    linkedDuplicates: [],
    linked: null,
  }
}
