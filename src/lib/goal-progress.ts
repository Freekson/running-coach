import type { GoalRecord } from './goals'

export type GoalStatus = 'ACTIVE' | 'ACHIEVED' | 'OVERDUE' | 'ARCHIVED'

export type GoalProgress = {
  status: GoalStatus
  timezone: string
  from: string | null
  through: string
  daysRemaining: number | null
  distanceMeters: number
  elevationGainM: number
  runCount: number
  surfaceUnknownRunCount: number
  bestTimeSeconds: number | null
  percent: number | null
  achieved: boolean
  planCoverage: 'UNAVAILABLE'
}

export type GoalWithProgress = GoalRecord & { progress: GoalProgress }
