import 'server-only'

import { z } from 'zod'
import { addHealthDays, healthLocalDay } from '@/lib/health-history'

export const confirmedActivityWindowSchema = z
  .strictObject({
    startDate: z.iso.date(),
    endDate: z.iso.date(),
  })
  .refine((window) => window.startDate <= window.endDate)
export type ConfirmedActivityWindow = z.infer<typeof confirmedActivityWindowSchema>
type CheckpointCoverage = {
  startDate: string
  endDate: string
  nextDate: string | null
  timezone: string
  confirmedWindows?: ConfirmedActivityWindow[]
}

/** Merge only checked ranges; a gap is never filled from activity presence. */
export function mergeConfirmedActivityWindows(
  windows: readonly ConfirmedActivityWindow[],
): ConfirmedActivityWindow[] {
  const merged: ConfirmedActivityWindow[] = []
  for (const window of [...windows].sort(
    (a, b) => a.startDate.localeCompare(b.startDate) || a.endDate.localeCompare(b.endDate),
  )) {
    const last = merged.at(-1)
    if (last && window.startDate <= addHealthDays(last.endDate, 1)) {
      if (window.endDate > last.endDate) last.endDate = window.endDate
    } else merged.push({ ...window })
  }
  return merged
}

/** Today's successful fetch cannot establish coverage of a complete local day. */
export function confirmedActivityWindows(
  checkpoint: CheckpointCoverage,
  checkedAt: Date | null,
  now: Date,
): ConfirmedActivityWindow[] {
  if (!checkedAt || checkedAt > now) return []
  const closedThrough = addHealthDays(
    healthLocalDay(checkedAt.toISOString(), checkpoint.timezone),
    -1,
  )
  const startDate =
    checkpoint.nextDate === null ? checkpoint.startDate : addHealthDays(checkpoint.nextDate, 1)
  const endDate = checkpoint.endDate < closedThrough ? checkpoint.endDate : closedThrough
  const windows = [
    ...(checkpoint.confirmedWindows ?? []),
    ...(startDate <= endDate ? [{ startDate, endDate }] : []),
  ]
    .map((window) => ({
      startDate: window.startDate,
      endDate: window.endDate < closedThrough ? window.endDate : closedThrough,
    }))
    .filter((window) => window.startDate <= window.endDate)
  return mergeConfirmedActivityWindows(windows)
}
