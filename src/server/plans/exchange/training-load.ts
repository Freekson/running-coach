import 'server-only'

import { createHash } from 'node:crypto'
import { addHealthDays } from '@/lib/health-history'
import { estimateWorkout } from '@/lib/workout-estimate'
import type { JsonPath, PreviewSession, TrainingWarning } from '@/lib/plan-import'
import type { ExchangeRequest, ExchangeResponse } from '@/schemas/plan-exchange.v1'
import type { WorkoutDefinition, WorkoutNode } from '@/schemas/workout-definition.v1'

export const LOAD_METHOD_VERSION = 'recorded-load-v1' as const
// Review heuristics, not validated physiological limits or promises of safety.
export const LOAD_REVIEW_RULES = {
  recentDays: 28,
  staleDays: 14,
  frequencyRatio: 1.5,
  frequencyExtraSessions: 2,
  volumeRatio: 1.75,
  extraDurationSeconds: 1800,
  extraDistanceMeters: 5000,
  longestRatio: 1.75,
  extraLongestSeconds: 1200,
  extraLongestMeters: 3000,
  denseIntervalSessions: 3,
} as const

export type LoadWorkout = {
  workoutId: string
  scheduledDate: string
  definition: WorkoutDefinition
  path: JsonPath
}

function intervalVolume(
  nodes: WorkoutNode[],
  inRepeat = false,
): { seconds: number; meters: number } {
  let seconds = 0
  let meters = 0
  for (const node of nodes) {
    if (node.type === 'repeat') {
      const child = intervalVolume(node.steps, inRepeat || node.count > 1)
      seconds += node.count * child.seconds
      meters += node.count * child.meters
    } else if (inRepeat && node.target.type !== 'free') {
      if (node.termination.type === 'time') seconds += node.termination.durationSeconds
      if (node.termination.type === 'distance') meters += node.termination.distanceMeters
    }
  }
  return { seconds, meters }
}

export function previewSession(workout: LoadWorkout): PreviewSession {
  const intervals = intervalVolume(workout.definition.steps)
  return {
    workoutId: workout.workoutId,
    scheduledDate: workout.scheduledDate,
    path: workout.path,
    estimate: estimateWorkout(workout.definition),
    intervalSeconds: intervals.seconds,
    intervalMeters: intervals.meters,
  }
}

/** Request-relative, deterministic and provider-neutral. Never reads records or saves a plan. */
export function reviewTrainingLoad(
  request: ExchangeRequest,
  response: ExchangeResponse,
  workouts: LoadWorkout[],
  evaluatedOn = request.athleteLocalDate,
) {
  const context = request.trainingContext
  const rules = LOAD_REVIEW_RULES
  const sessions = workouts.filter((w) => w.definition.sport === 'RUNNING').map(previewSession)
  const weeks = Array.from(
    {
      length:
        Math.ceil(
          (Date.parse(response.detailWindow.endDate) -
            Date.parse(response.detailWindow.startDate)) /
            604800000,
        ) + 1,
    },
    (_, index) => {
      const startDate = addHealthDays(response.detailWindow.startDate, index * 7)
      const endDate = [addHealthDays(startDate, 6), response.detailWindow.endDate].sort()[0]
      const entries = sessions.filter(
        (s) => s.scheduledDate >= startDate && s.scheduledDate <= endDate,
      )
      return {
        startDate,
        endDate,
        workoutIds: entries.map((s) => s.workoutId),
        sessions: entries.length,
        durationSeconds: entries.reduce((sum, s) => sum + s.estimate.durationSeconds.min, 0),
        distanceMeters: entries.reduce((sum, s) => sum + s.estimate.distanceMeters.min, 0),
        durationIncomplete: entries.some((s) => s.estimate.durationSeconds.incomplete),
        distanceIncomplete: entries.some((s) => s.estimate.distanceMeters.incomplete),
        intervalSeconds: entries.reduce((sum, s) => sum + s.intervalSeconds, 0),
        intervalMeters: entries.reduce((sum, s) => sum + s.intervalMeters, 0),
      }
    },
  ).filter((week) => week.startDate <= response.detailWindow.endDate)
  const warnings: TrainingWarning[] = []
  const completeWeeks = context.recentTrainingSummary.weeks
    .slice(-4)
    .filter((w) => w.coverage === 'complete')
  const historyWindow = {
    startDate: addHealthDays(context.selection.window.endDate, -27),
    endDate: context.selection.window.endDate,
  }
  const recentRuns = context.recentRunSamples.filter(
    (r) => r.localDate >= historyWindow.startDate && r.localDate <= historyWindow.endDate,
  )
  const snapshotAgeDays = Math.max(
    0,
    (Date.parse(evaluatedOn) - Date.parse(request.athleteLocalDate)) / 86400000,
  )
  const stale =
    snapshotAgeDays > rules.staleDays ||
    context.daysSinceLastRecordedRun.value === null ||
    context.daysSinceLastRecordedRun.value + snapshotAgeDays > rules.staleDays
  const reliable =
    request.consent.recordedActivityMetrics &&
    context.activityHistoryCoverage.status === 'sufficient' &&
    completeWeeks.length === 4 &&
    !stale
  const confidence = reliable ? ('moderate' as const) : ('low' as const)
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ request, response, evaluatedOn }))
    .digest('hex')
  const warn = (
    code: string,
    selected: PreviewSession[],
    message: string,
    evidence: TrainingWarning['evidence'] = {
      proposed: null,
      observed: null,
      unit: null,
      window: historyWindow,
    },
    path: JsonPath = selected[0]?.path ?? [],
    level: TrainingWarning['confidence'] = confidence,
  ) => {
    const workoutIds = selected.map((s) => s.workoutId).sort()
    const id = createHash('sha256')
      .update(
        JSON.stringify({ fingerprint, code, workoutIds, evidence, method: LOAD_METHOD_VERSION }),
      )
      .digest('hex')
      .slice(0, 24)
    warnings.push({
      id,
      severity: 'warning',
      code,
      confidence: level,
      path,
      workoutIds,
      message,
      evidence,
    })
  }
  if (!reliable)
    warn(
      'limited_history',
      sessions,
      'Recent recorded history is absent, partial, withheld or stale. Confidence is low; missing totals are unknown, not zero. Review the starting workload without treating old PBs as current fitness.',
      undefined,
      ['trainingContext'],
      'low',
    )
  if (stale && context.daysSinceLastRecordedRun.value !== null)
    warn(
      'recorded_break',
      sessions,
      'The last recorded run in the issued snapshot is more than 14 days before this preview. This describes a recording gap, not proof of inactivity; review the return workload.',
      undefined,
      ['trainingContext', 'daysSinceLastRecordedRun'],
      'low',
    )
  if (
    recentRuns.length &&
    recentRuns.some(
      (run) =>
        run.averageHr.value === null ||
        run.averagePace.value === null ||
        run.lapSamples === null ||
        run.flags.length > 0,
    )
  )
    warn(
      'limited_intensity_evidence',
      sessions,
      'Recent samples have missing pace, HR or laps, or flagged measurements. Frequency and volume can still be reviewed; effort and interval comparisons have low confidence and no zones are inferred.',
      undefined,
      ['trainingContext', 'recentRunSamples'],
      'low',
    )

  // Use only complete recent weekly metrics. Partial samples never become invented weekly totals.
  const average = (key: 'completedSessions' | 'duration' | 'distance') => {
    const values = completeWeeks.flatMap((w) => (w[key].value === null ? [] : [w[key].value]))
    return {
      mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
      count: values.length,
    }
  }
  const frequency = average('completedSessions'),
    duration = average('duration'),
    distance = average('distance')
  for (const week of weeks) {
    const selected = sessions.filter((s) => week.workoutIds.includes(s.workoutId))
    const window = { startDate: week.startDate, endDate: week.endDate }
    if (
      frequency.mean !== null &&
      week.sessions >= frequency.mean + rules.frequencyExtraSessions &&
      week.sessions > frequency.mean * rules.frequencyRatio
    )
      warn(
        'frequency_jump',
        selected,
        'Scheduled running frequency clearly exceeds the mean of available complete recent weeks. Review these sessions; this is not a fixed safe-increase rule.',
        {
          proposed: week.sessions,
          observed: frequency.mean,
          unit: 'sessions',
          window,
          observedWindow: historyWindow,
          observedWeeks: frequency.count,
        },
        undefined,
        reliable && frequency.count === 4 ? 'moderate' : 'low',
      )
    for (const [code, proposed, observed, extra, unit] of [
      ['duration_jump', week.durationSeconds, duration, rules.extraDurationSeconds, 's'],
      ['distance_jump', week.distanceMeters, distance, rules.extraDistanceMeters, 'm'],
    ] as const) {
      if (
        observed.mean !== null &&
        proposed >= observed.mean + extra &&
        proposed > observed.mean * rules.volumeRatio
      )
        warn(
          code,
          selected,
          'The proposed weekly minimum exceeds recent recorded average volume by a large margin. Unknown portions may increase the total; review the listed sessions.',
          {
            proposed,
            observed: observed.mean,
            unit,
            window,
            observedWindow: historyWindow,
            observedWeeks: observed.count,
          },
          undefined,
          reliable && observed.count === 4 ? 'moderate' : 'low',
        )
    }
    const intervals = selected.filter((s) => s.intervalSeconds >= 300 || s.intervalMeters >= 1000)
    if (intervals.length >= rules.denseIntervalSessions)
      warn(
        'dense_intervals',
        intervals,
        'At least three sessions contain substantial targeted repeat work in this week. Repeats include recovery and do not prove hard effort; review intensity and recovery spacing.',
        { proposed: intervals.length, observed: null, unit: 'sessions', window },
      )
  }
  const observedLongestDistance = [
    ...completeWeeks.flatMap((w) => (w.longestRun.value === null ? [] : [w.longestRun.value])),
    ...recentRuns.flatMap((r) => (r.distance.value === null ? [] : [r.distance.value])),
  ]
  const observedDurations = recentRuns.flatMap((r) =>
    r.elapsedTime.value === null ? [] : [r.elapsedTime.value],
  )
  const longestDistance = observedLongestDistance.length
    ? Math.max(...observedLongestDistance)
    : null
  const longestDuration = observedDurations.length ? Math.max(...observedDurations) : null
  for (const session of sessions) {
    for (const [code, proposed, observed, extra, unit] of [
      [
        'long_distance',
        session.estimate.distanceMeters.min,
        longestDistance,
        rules.extraLongestMeters,
        'm',
      ],
      [
        'long_duration',
        session.estimate.durationSeconds.min,
        longestDuration,
        rules.extraLongestSeconds,
        's',
      ],
    ] as const) {
      if (
        observed !== null &&
        proposed >= observed + extra &&
        proposed > observed * rules.longestRatio
      )
        warn(
          code,
          [session],
          'This session is substantially longer than the longest available recent observation. Duration comparisons use selected run samples, which may omit other sessions; review before approval.',
          { proposed, observed, unit, window: historyWindow },
          session.path,
          code === 'long_duration' ? 'low' : confidence,
        )
    }
  }
  const intervals = sessions.filter((s) => s.intervalSeconds > 0 || s.intervalMeters > 0)
  if (intervals.length) {
    warn(
      'interval_evidence_limited',
      intervals,
      'Targeted repeat volume is approximate and includes recovery steps. Recorded laps and average HR do not establish historical hard-work volume or threshold zones; review these sessions.',
      {
        proposed: intervals.reduce((sum, s) => sum + s.intervalSeconds, 0),
        observed: null,
        unit: 's',
        window: response.detailWindow,
      },
      undefined,
      'low',
    )
    const ordered = [...intervals].sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate))
    for (let i = 1; i < ordered.length; i++) {
      if (
        Date.parse(ordered[i].scheduledDate) - Date.parse(ordered[i - 1].scheduledDate) <
        172800000
      )
        warn(
          'interval_spacing',
          [ordered[i - 1], ordered[i]],
          'Targeted repeat sessions are less than two local calendar days apart. Review effort and recovery; this rule does not diagnose insufficient recovery.',
          undefined,
          undefined,
          'low',
        )
    }
  }
  const paced = workouts.filter(
    (w) => w.definition.sport === 'RUNNING' && hasPace(w.definition.steps),
  )
  if (paced.length) {
    // No session-specific terrain/climate/sensor-quality fields exist in v1. Even
    // paired high-quality metrics cannot prove comparable prescription conditions.
    warn(
      'pace_comparability',
      sessions.filter((s) => paced.some((w) => w.workoutId === s.workoutId)),
      'Pace prescriptions cannot establish equivalent effort from whole-run pace/HR. Session terrain, climate and sensor reliability are not established by this contract; intervals differ from steady runs. No threshold pace is inferred, and missing HR/laps never blocks approval.',
      undefined,
      undefined,
      'low',
    )
  }
  return { sessions, weeks, warnings, methodVersion: LOAD_METHOD_VERSION }
}

function hasPace(nodes: WorkoutNode[]): boolean {
  return nodes.some((node) =>
    node.type === 'repeat' ? hasPace(node.steps) : node.target.type === 'pace',
  )
}
