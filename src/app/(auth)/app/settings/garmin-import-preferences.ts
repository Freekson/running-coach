'use client'

import { useCallback, useState, useSyncExternalStore } from 'react'
import { z } from 'zod'
import type { ImportStreamId } from '@/lib/garmin-import-state'

const preferencesSchema = z.strictObject({
  daily_summary: z.boolean().optional(),
  sleep: z.boolean().optional(),
  activities: z.boolean().optional(),
})
const changedEvent = 'garmin-import-preferences-changed'
function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange)
  window.addEventListener(changedEvent, onChange)
  return () => {
    window.removeEventListener('storage', onChange)
    window.removeEventListener(changedEvent, onChange)
  }
}
const serverSnapshot = () => null

/** Persist booleans only, under a scope supplied by the authenticated Settings page. */
export function useGarminImportPreferences(
  preferenceKey: string | undefined,
  initial: Partial<Record<ImportStreamId, boolean>>,
) {
  const [session, setSession] = useState<{
    key: typeof preferenceKey
    expanded: typeof initial
    snapshot?: string | null
  }>({ key: preferenceKey, expanded: initial })
  const read = useCallback(() => {
    if (!preferenceKey) return null
    try {
      return window.localStorage.getItem(preferenceKey)
    } catch {
      return null
    }
  }, [preferenceKey])
  const snapshot = useSyncExternalStore(subscribe, read, serverSnapshot)
  let saved: Partial<Record<ImportStreamId, boolean>> | null = null
  try {
    if (snapshot && snapshot.length <= 256) {
      const result = preferencesSchema.safeParse(JSON.parse(snapshot) as unknown)
      if (result.success) saved = result.data
    }
  } catch {
    /* Ignore malformed UI preferences. */
  }
  const expanded = {
    ...initial,
    ...saved,
    ...(session.key === preferenceKey && session.snapshot === snapshot ? session.expanded : {}),
  }
  function toggle(streamId: ImportStreamId, open: boolean) {
    const next = { ...expanded, [streamId]: open }
    setSession({ key: preferenceKey, expanded: next, snapshot })
    if (!preferenceKey) return
    try {
      window.localStorage.setItem(preferenceKey, JSON.stringify(next))
      window.dispatchEvent(new Event(changedEvent))
    } catch {
      /* Keep the session preference when browser storage is unavailable. */
    }
  }
  return { expanded, toggle }
}
