import 'server-only'

import type { Prisma } from '@prisma/client'
import type { GoalRecord } from '@/lib/goals'
import type { GoalProgress, GoalWithProgress } from '@/lib/goal-progress'
import { addHealthDays, healthLocalDay } from '@/lib/health-history'
import { timezoneSchema } from '@/lib/plan-constraints'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { activityReadScope } from '@/server/activity/visibility'
import { activityDayBoundary } from '@/server/activity/history'
import { recordedActivitySurface } from '@/server/activity/surface'
import { getPrismaClient } from '@/server/db/client'

export type GoalActivity = {
  startedAt: Date
  sportType: string
  surfaceType: string | null
  distanceMeters: number | null
  elapsedSeconds: number | null
  elevationGainM: number | null
}

function goalWindow(goal: GoalRecord, today: string) {
  const through = goal.targetDate && goal.targetDate < today ? goal.targetDate : today
  let from: string | null = null
  if (goal.measurementWindow === 'WEEK') {
    const weekday = new Date(`${through}T00:00:00Z`).getUTCDay()
    from = addHealthDays(through, -((weekday + 6) % 7))
  } else if (goal.measurementWindow === 'MONTH') from = `${through.slice(0, 7)}-01`
  else if (goal.measurementWindow === 'YEAR') from = `${through.slice(0, 4)}-01-01`
  return { from, through }
}

function prepareActivities(activities: readonly GoalActivity[], timezone: string, now: Date) {
  // Reuse one formatter, and calculate each activity date once for the entire goals list.
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return activities
    .filter((activity) => activity.sportType === 'RUNNING' && activity.startedAt <= now)
    .map((activity) => {
      const parts = formatter.formatToParts(activity.startedAt)
      const part = (type: string) => parts.find((entry) => entry.type === type)?.value
      return { ...activity, date: `${part('year')}-${part('month')}-${part('day')}` }
    })
}

function completionPercent(value: number, target: number, precision: number) {
  if (value >= target) return 100
  // Stored millimeters / centimeters are integers; divide after multiplication, not before.
  return Math.floor((Math.round(value * precision) * 100) / Math.round(target * precision))
}

function calculatePreparedProgress(
  goal: GoalRecord,
  activities: ReturnType<typeof prepareActivities>,
  timezone: string,
  today: string,
): GoalProgress {
  const { from, through } = goalWindow(goal, today)
  let distanceMeters = 0
  let elevationGainM = 0
  let runCount = 0
  let surfaceUnknownRunCount = 0
  let bestTimeSeconds: number | null = null
  let completed = false
  for (const activity of activities) {
    if (activity.date > through || (from !== null && activity.date < from)) continue
    if (goal.surface !== 'ANY' && activity.surfaceType !== goal.surface) {
      if (activity.surfaceType === null) surfaceUnknownRunCount++
      continue
    }
    runCount++
    distanceMeters += activity.distanceMeters ?? 0
    elevationGainM += activity.elevationGainM ?? 0
    const enoughElevation =
      !goal.elevationGainM ||
      (activity.elevationGainM !== null && activity.elevationGainM >= goal.elevationGainM)
    if (activity.distanceMeters === null || !enoughElevation) continue
    if (goal.type === 'COMPLETION' && activity.distanceMeters >= goal.distanceMeters!)
      completed = true
    // Shorter runs cannot establish the result. Slightly longer whole runs qualify
    // conservatively without estimating splits or scaling pace.
    if (
      goal.type === 'PERFORMANCE' &&
      activity.distanceMeters >= goal.distanceMeters! &&
      activity.distanceMeters <= goal.distanceMeters! * 1.01 &&
      activity.elapsedSeconds !== null &&
      activity.elapsedSeconds > 0
    )
      bestTimeSeconds = Math.min(bestTimeSeconds ?? Infinity, activity.elapsedSeconds)
  }
  distanceMeters = Math.round(distanceMeters * 1000) / 1000
  elevationGainM = Math.round(elevationGainM * 100) / 100
  const percent =
    goal.type === 'VOLUME'
      ? Math.min(
          completionPercent(distanceMeters, goal.distanceMeters!, 1000),
          goal.elevationGainM ? completionPercent(elevationGainM, goal.elevationGainM, 100) : 100,
        )
      : goal.type === 'CONSISTENCY'
        ? completionPercent(runCount, goal.targetCount!, 1)
        : null
  const achieved =
    percent !== null
      ? percent === 100
      : goal.type === 'COMPLETION'
        ? completed
        : goal.targetTimeSeconds !== null &&
          bestTimeSeconds !== null &&
          bestTimeSeconds <= goal.targetTimeSeconds
  return {
    status: goal.archived
      ? 'ARCHIVED'
      : achieved
        ? 'ACHIEVED'
        : goal.targetDate && goal.targetDate < today
          ? 'OVERDUE'
          : 'ACTIVE',
    timezone,
    from,
    through,
    daysRemaining: goal.targetDate
      ? Math.round(
          (Date.parse(`${goal.targetDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
            86_400_000,
        )
      : null,
    distanceMeters,
    elevationGainM,
    runCount,
    surfaceUnknownRunCount,
    bestTimeSeconds,
    percent,
    achieved,
    planCoverage: 'UNAVAILABLE',
  }
}

export function calculateGoalProgress(
  goal: GoalRecord,
  activities: readonly GoalActivity[],
  timezone: string,
  now: Date,
): GoalProgress {
  return calculatePreparedProgress(
    goal,
    prepareActivities(activities, timezone, now),
    timezone,
    healthLocalDay(now.toISOString(), timezone),
  )
}

/** Callers load goals using the same verified owner; client goal definitions are never accepted. */
export async function withGoalProgress(
  owner: OwnerContext,
  goals: readonly GoalRecord[],
  now = new Date(),
  client?: Prisma.TransactionClient,
): Promise<GoalWithProgress[]> {
  const userId = ownerId(owner)
  if (!goals.length) return []
  const prisma = client ?? (await getPrismaClient())
  const [profile, scope] = await Promise.all([
    prisma.athleteProfile.findUnique({ where: { userId }, select: { preferredTimezone: true } }),
    activityReadScope(owner, prisma),
  ])
  const parsedZone = timezoneSchema.safeParse(profile?.preferredTimezone)
  const timezone = parsedZone.success ? parsedZone.data : 'UTC'
  const today = healthLocalDay(now.toISOString(), timezone)
  const windows = goals.map((goal) => goalWindow(goal, today))
  const from = windows.some((window) => window.from === null)
    ? null
    : windows.reduce((first, window) => (window.from! < first ? window.from! : first), today)
  const through = windows.reduce(
    (last, window) => (window.through > last ? window.through : last),
    windows[0].through,
  )
  const rows = await prisma.activity.findMany({
    where: {
      AND: [
        scope,
        {
          sportType: 'RUNNING',
          startedAt: {
            ...(from ? { gte: activityDayBoundary(from, timezone) } : {}),
            lte: now,
            ...(through < today
              ? { lt: activityDayBoundary(addHealthDays(through, 1), timezone) }
              : {}),
          },
          duplicateCandidatesAsFirst: { none: { userId } },
          duplicateCandidatesAsSecond: { none: { userId } },
        },
      ],
    },
    select: {
      startedAt: true,
      sportType: true,
      surfaceType: true,
      sourceProvider: true,
      sourceSportType: true,
      distanceMeters: true,
      elapsedMs: true,
      elevationGainMeters: true,
    },
  })
  const activities = prepareActivities(
    rows.map((row): GoalActivity => ({
      startedAt: row.startedAt,
      sportType: row.sportType,
      // Recognize recorded subtypes on legacy rows without rewriting stored data.
      surfaceType: recordedActivitySurface(row),
      distanceMeters: row.distanceMeters?.toNumber() ?? null,
      elapsedSeconds:
        row.elapsedMs !== null && row.elapsedMs > 0 && row.elapsedMs <= Number.MAX_SAFE_INTEGER
          ? Number(row.elapsedMs) / 1000
          : null,
      elevationGainM: row.elevationGainMeters?.toNumber() ?? null,
    })),
    timezone,
    now,
  )
  return goals.map((goal) => ({
    ...goal,
    progress: calculatePreparedProgress(goal, activities, timezone, today),
  }))
}
