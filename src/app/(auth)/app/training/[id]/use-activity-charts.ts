'use client'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { activityChartsSchema, type ActivityCharts } from '@/lib/activity-detail'

const errorSchema = z.object({ code: z.string(), retryAt: z.iso.datetime().nullable().optional() })
/** Cache only in this mounted detail view; no global cache, browser storage, or persisted GPS. */
export function useActivityCharts(id: string) {
  const [charts, setCharts] = useState<ActivityCharts | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryAt, setRetryAt] = useState<string | null>(null)
  const [clock, setClock] = useState(() => Date.now())
  const active = useRef(true)
  const request = useRef<Promise<void> | null>(null)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      controller.current?.abort()
    }
  }, [])
  useEffect(() => {
    if (!retryAt || Date.parse(retryAt) <= clock) return
    const timer = window.setTimeout(
      () => setClock(Date.now()),
      Math.max(1000, Math.min(60_000, Date.parse(retryAt) - Date.now())),
    )
    return () => window.clearTimeout(timer)
  }, [retryAt, clock])
  function load(force = false): Promise<void> {
    if (request.current) return request.current
    if ((!force && (charts || error)) || (retryAt && Date.parse(retryAt) > Date.now()))
      return Promise.resolve()
    controller.current = new AbortController()
    setPending(true)
    setError(null)
    request.current = (async () => {
      try {
        const response = await fetch(`/api/activities/${id}/charts`, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.current?.signal,
        })
        const payload: unknown = await response.json().catch(() => null)
        if (!active.current) return
        if (!response.ok) {
          const parsed = errorSchema.safeParse(payload)
          setError(
            response.status === 401
              ? 'AUTH_REQUIRED'
              : parsed.success
                ? parsed.data.code
                : 'UNAVAILABLE',
          )
          const seconds = Number(response.headers.get('Retry-After'))
          setRetryAt(
            parsed.success && parsed.data.retryAt
              ? parsed.data.retryAt
              : response.status === 429
                ? new Date(
                    Date.now() +
                      (seconds > 0 && Number.isFinite(seconds)
                        ? Math.min(seconds, 30 * 86400)
                        : 60) *
                        1000,
                  ).toISOString()
                : null,
          )
          setClock(Date.now())
          return
        }
        const parsed = activityChartsSchema.safeParse(payload)
        if (!parsed.success) {
          setError('UNAVAILABLE')
          return
        }
        setCharts(parsed.data)
        setRetryAt(null)
      } catch {
        if (active.current) setError('NETWORK_ERROR')
      } finally {
        request.current = null
        if (active.current) setPending(false)
      }
    })()
    return request.current
  }
  return {
    charts,
    pending,
    error,
    retryAt,
    coolingDown: !!retryAt && Date.parse(retryAt) > clock,
    load,
  }
}
