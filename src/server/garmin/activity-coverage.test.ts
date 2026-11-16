import { expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { confirmedActivityWindows, mergeConfirmedActivityWindows } from './activity-coverage'

it('merges overlapping and adjacent checked windows without mutating inputs or filling gaps', () => {
  const windows = [
    { startDate: '2026-10-01', endDate: '2026-10-07' },
    { startDate: '2026-10-07', endDate: '2026-10-14' },
    { startDate: '2026-10-15', endDate: '2026-10-20' },
    { startDate: '2026-11-01', endDate: '2026-11-02' },
  ]
  const before = JSON.stringify(windows)
  expect(mergeConfirmedActivityWindows(windows)).toEqual([
    { startDate: '2026-10-01', endDate: '2026-10-20' },
    { startDate: '2026-11-01', endDate: '2026-11-02' },
  ])
  expect(JSON.stringify(windows)).toBe(before)
})
it('retains prior coverage during an unfinished recent pass and never confirms today or a future sync', () => {
  const at = new Date('2026-11-15T03:00:00Z')
  const checkpoint = {
    timezone: 'Asia/Tokyo',
    startDate: '2026-11-08',
    endDate: '2026-11-15',
    nextDate: '2026-11-15',
    confirmedWindows: [{ startDate: '2026-08-23', endDate: '2026-11-13' }],
  }
  expect(confirmedActivityWindows(checkpoint, at, at)).toEqual(checkpoint.confirmedWindows)
  expect(confirmedActivityWindows({ ...checkpoint, nextDate: null }, at, at)).toEqual([
    { startDate: '2026-08-23', endDate: '2026-11-14' },
  ])
  expect(confirmedActivityWindows(checkpoint, null, at)).toEqual([])
  expect(confirmedActivityWindows(checkpoint, new Date('2027-01-01'), at)).toEqual([])
})
