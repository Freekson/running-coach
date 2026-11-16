import { z } from 'zod'
import { localDateSchema } from './goals'
import { timezoneSchema } from './plan-constraints'

// Leave room for padded weeks and timestamp-query margins at both ends.
export const calendarMinDate = '1900-01-01'
export const calendarMaxDate = '9998-12-31'
const calendarDateSchema = localDateSchema.refine(
  (value) => value >= calendarMinDate && value <= calendarMaxDate,
  'Choose a calendar date between 1900 and 9998',
)
export const calendarQuerySchema = z.object({
  date: calendarDateSchema.optional(),
  view: z.enum(['week', 'month']).default('week'),
})
export type CalendarQuery = z.infer<typeof calendarQuerySchema>

// UTC is an arithmetic container here, never a scheduled session timestamp.
export function addCalendarDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

export function calendarToday(timezone: string, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

export function calendarRange(date: string, view: CalendarQuery['view']) {
  calendarDateSchema.parse(date)
  const day = new Date(`${date}T00:00:00Z`)
  const start = view === 'month' ? `${date.slice(0, 7)}-01` : date
  const offset = (new Date(`${start}T00:00:00Z`).getUTCDay() + 6) % 7
  const first = addCalendarDays(start, -offset)
  const monthEnd = new Date(day)
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0)
  const last =
    view === 'week'
      ? addCalendarDays(first, 6)
      : addCalendarDays(monthEnd.toISOString().slice(0, 10), (7 - monthEnd.getUTCDay()) % 7)
  const dates: string[] = []
  const maxDays = view === 'week' ? 7 : 42
  let next = first
  for (; next <= last && dates.length < maxDays; next = addCalendarDays(next, 1)) dates.push(next)
  if (next <= last) throw new RangeError('Calendar range exceeds its day limit')
  return { start: first, end: last, dates }
}

export function adjacentCalendarDate(date: string, view: CalendarQuery['view'], direction: -1 | 1) {
  calendarDateSchema.parse(date)
  const clamp = (value: string) =>
    value < calendarMinDate ? calendarMinDate : value > calendarMaxDate ? calendarMaxDate : value
  if (view === 'week') return clamp(addCalendarDays(date, direction * 7))
  const value = new Date(`${date.slice(0, 7)}-01T00:00:00Z`)
  value.setUTCMonth(value.getUTCMonth() + direction)
  return clamp(value.toISOString().slice(0, 10))
}

export const rescheduleWorkoutSchema = z.strictObject({
  planId: z.uuid().toLowerCase(),
  expectedRevisionId: z.uuid().toLowerCase(),
  workoutId: z.uuid().toLowerCase(),
  scheduledDate: localDateSchema,
  timezone: timezoneSchema,
})

export type CalendarWorkout = {
  id: string
  planId: string
  revisionId: string
  name: string
  sport: string
  date: string
  timezone: string
  status: 'planned' | 'completed' | 'missed' | 'cancelled'
  locked: boolean
  editable: boolean
  movedFrom: string | null
  minDate: string
  maxDate: string
  activity: { id: string; title: string } | null
}

export type CalendarActivity = {
  id: string
  title: string
  date: string
  timezone: string
  linkedWorkoutId: string | null
}
export type CalendarDay = {
  date: string
  workouts: CalendarWorkout[]
  activities: CalendarActivity[]
  // Only an empty day inside an approved detail window can be called rest.
  rest: boolean
}
export type TrainingCalendarData = {
  date: string
  view: CalendarQuery['view']
  timezone: string
  today: string
  hasPlan: boolean
  days: CalendarDay[]
}

export type RescheduleResult =
  | { success: true }
  | {
      success: false
      code: 'unauthorized' | 'invalid' | 'missing' | 'conflict' | 'locked' | 'unavailable'
      error: string
    }
