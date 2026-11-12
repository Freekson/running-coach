'use client'

import { useEffect, useSyncExternalStore, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { activityTimezoneCookie } from '@/lib/activity-history'

const subscribe = () => () => {}
const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
const serverTimezone = () => null

export function useActivityTimezone(serverZone: string) {
  const timezone = useSyncExternalStore(subscribe, browserTimezone, serverTimezone)
  const { refresh } = useRouter()
  const [, startTransition] = useTransition()
  useEffect(() => {
    if (!timezone) return
    const encoded = encodeURIComponent(timezone)
    const cookie = `${activityTimezoneCookie}=${encoded}`
    if (!document.cookie.split('; ').includes(cookie)) {
      document.cookie = `${cookie}; Path=/; SameSite=Lax; Max-Age=31536000`
    }
    if (timezone !== serverZone) startTransition(() => refresh())
  }, [timezone, serverZone, refresh])
  return { timezone, ready: timezone !== null && timezone === serverZone }
}
