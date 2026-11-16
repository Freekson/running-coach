import {
  calendarRange,
  type CalendarWorkout,
  type TrainingCalendarData,
} from '@/lib/training-calendar'

// Synthetic data shared only by feature tests and stories.
export function calendarFixture(view: 'week' | 'month' = 'week'): TrainingCalendarData {
  const workout: CalendarWorkout = {
    id: '00000000-0000-4000-8000-000000000001',
    planId: '00000000-0000-4000-8000-000000000002',
    revisionId: '00000000-0000-4000-8000-000000000003',
    name: 'Easy run',
    sport: 'RUNNING',
    date: '2026-11-14',
    timezone: 'America/New_York',
    status: 'planned',
    locked: false,
    editable: true,
    movedFrom: '2026-11-13',
    minDate: '2026-11-01',
    maxDate: '2026-11-28',
    activity: null,
  }
  const workouts: CalendarWorkout[] = [
    workout,
    {
      ...workout,
      id: '00000000-0000-4000-8000-000000000004',
      name: 'Evening recovery',
      movedFrom: null,
    },
    {
      ...workout,
      id: '00000000-0000-4000-8000-000000000005',
      name: 'Completed session',
      date: '2026-11-11',
      status: 'completed',
      locked: true,
      editable: false,
      movedFrom: null,
      activity: { id: 'saved', title: 'Morning run' },
    },
    {
      ...workout,
      id: '00000000-0000-4000-8000-000000000006',
      name: 'Missed session',
      date: '2026-11-10',
      status: 'missed',
      editable: false,
      movedFrom: null,
    },
    {
      ...workout,
      id: '00000000-0000-4000-8000-000000000007',
      name: 'Canceled session',
      date: '2026-11-13',
      status: 'cancelled',
      editable: false,
      movedFrom: null,
    },
  ]
  return {
    date: '2026-11-12',
    view,
    timezone: 'America/New_York',
    today: '2026-11-12',
    hasPlan: true,
    days: calendarRange('2026-11-12', view).dates.map((date) => ({
      date,
      workouts: workouts.filter((w) => w.date === date),
      activities:
        date === '2026-11-12'
          ? [
              {
                id: 'unlinked',
                title: 'Saved trail run',
                date,
                timezone: 'Asia/Tokyo',
                linkedWorkoutId: null,
              },
            ]
          : [],
      rest: ['2026-11-09', '2026-11-15'].includes(date),
    })),
  }
}
