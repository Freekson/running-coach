'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import type { TrainingCalendarData } from '@/lib/training-calendar'
import { rescheduleWorkoutAction } from './actions'
import { TrainingCalendar } from './training-calendar'

export function CalendarController({ data }: { data: TrainingCalendarData }) {
  const router = useRouter()
  const [refreshing, startTransition] = useTransition()
  return (
    <TrainingCalendar
      data={data}
      refreshing={refreshing}
      onReload={() => startTransition(() => router.refresh())}
      onReschedule={async (input) => {
        const result = await rescheduleWorkoutAction(input)
        if (result.success) startTransition(() => router.refresh())
        return result
      }}
    />
  )
}
