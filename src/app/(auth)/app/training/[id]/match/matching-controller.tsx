'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { ActivityMatchingData } from '@/lib/activity-matching'
import { linkActivityAction, unlinkActivityAction } from './actions'
import { ActivityMatching } from './activity-matching'

export function MatchingController({ data }: { data: ActivityMatchingData }) {
  const router = useRouter()
  const [refreshing, startTransition] = useTransition()
  return (
    <ActivityMatching
      data={data}
      refreshing={refreshing}
      onLink={linkActivityAction}
      onUnlink={unlinkActivityAction}
      onReload={() => startTransition(() => router.refresh())}
      onSearch={(date) =>
        startTransition(() =>
          router.push(`/app/training/${data.activityId}/match?date=${encodeURIComponent(date)}`),
        )
      }
    />
  )
}
