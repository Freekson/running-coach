import { expect, it, vi } from 'vitest'
import { planReminderEvent } from './reminder-event'
import { constraintsFixture, contentFixture } from './fixtures'

vi.mock('server-only', () => ({}))
function plan() {
  return {
    id: 'synthetic-plan',
    goalName: 'Synthetic goal',
    goalTargetDate: '2090-03-31',
    revisionId: 'synthetic-revision',
    snapshot: { ...contentFixture(), constraints: constraintsFixture },
  }
}
const at = (date: string) => new Date(`${date}T12:00:00Z`)

it('becomes due exactly seven calendar days before the detail ends and stays due when exhausted', () => {
  const p = plan()
  expect(planReminderEvent(p, at('2090-01-20'))).toBeNull()
  expect(planReminderEvent(p, at('2090-01-21'))).toMatchObject({
    exhausted: false,
    detailEndDate: '2090-01-28',
  })
  expect(planReminderEvent(p, at('2090-01-28'))?.exhausted).toBe(false)
  expect(planReminderEvent(p, at('2090-01-29'))?.exhausted).toBe(true)
})

it('keeps the same fingerprint across reloads, renamed goals and increasing urgency', () => {
  const p = plan()
  const event = planReminderEvent(p, at('2090-01-21'))!
  expect(planReminderEvent(p, at('2090-01-21'))?.fingerprint).toBe(event.fingerprint)
  expect(planReminderEvent({ ...p, goalName: 'Renamed' }, at('2090-02-01'))?.fingerprint).toBe(
    event.fingerprint,
  )
  expect(
    planReminderEvent({ ...p, revisionId: 'new-revision' }, at('2090-01-21'))?.fingerprint,
  ).not.toBe(event.fingerprint)
  expect(planReminderEvent({ ...p, id: 'other-plan' }, at('2090-01-21'))?.fingerprint).not.toBe(
    event.fingerprint,
  )
})

it('uses local calendar days across UTC boundaries and daylight-saving changes', () => {
  const p = plan()
  p.snapshot.constraints.timezone = 'Asia/Tokyo'
  expect(planReminderEvent(p, new Date('2090-01-20T14:59:59Z'))).toBeNull()
  expect(planReminderEvent(p, new Date('2090-01-20T15:00:00Z'))).not.toBeNull()
  p.snapshot.constraints.timezone = 'America/New_York'
  p.snapshot.detailWindow = { startDate: '2090-03-01', endDate: '2090-03-16' }
  expect(planReminderEvent(p, at('2090-03-08'))).toBeNull()
  expect(planReminderEvent(p, at('2090-03-09'))).not.toBeNull()
})

it('is quiet for future plans, complete macro coverage, and ended horizons', () => {
  const p = plan()
  expect(planReminderEvent(p, at('2089-12-31'))).toBeNull()
  expect(planReminderEvent(p, at('2090-04-01'))).toBeNull()
  expect(planReminderEvent(p, at('2090-03-18'))?.nextAction).toBe('review-plan')
  expect(planReminderEvent(p, at('2090-03-17'))?.nextAction).toBe('refresh')
  p.snapshot.detailWindow = { startDate: '2090-03-04', endDate: '2090-03-31' }
  expect(planReminderEvent(p, at('2090-03-24'))).toBeNull()
})

it.each([
  ['2090-02-03', '2090-01-20'],
  ['2090-02-04', '2090-01-21'],
])(
  'warns by the refresh deadline for a macro ending %s and keeps the unresolved event',
  (endDate, deadline) => {
    const p = plan()
    p.goalTargetDate = endDate
    p.snapshot.macroPlan.endDate = endDate
    p.snapshot.macroPlan.phases[0].endDate = endDate
    const before = new Date(`${deadline}T12:00:00Z`)
    before.setUTCDate(before.getUTCDate() - 1)
    expect(planReminderEvent(p, before)).toBeNull()
    const event = planReminderEvent(p, at(deadline))!
    expect(event).toMatchObject({ nextAction: 'refresh', refreshByDate: deadline })
    const day = new Date(`${deadline}T12:00:00Z`)
    day.setUTCDate(day.getUTCDate() + 1)
    for (; day <= at(endDate); day.setUTCDate(day.getUTCDate() + 1)) {
      expect(planReminderEvent(p, day)).toMatchObject({
        fingerprint: event.fingerprint,
        nextAction: 'review-plan',
      })
    }
    expect(planReminderEvent(p, day)).toBeNull()
  },
)

it('resolves when an approved revision extends the detail window', () => {
  const p = plan()
  expect(planReminderEvent(p, at('2090-01-21'))).not.toBeNull()
  p.revisionId = 'extended-revision'
  p.snapshot.detailWindow = { startDate: '2090-01-22', endDate: '2090-02-18' }
  expect(planReminderEvent(p, at('2090-01-21'))).toBeNull()
  expect(planReminderEvent(p, at('2090-02-11'))).not.toBeNull()
})

it('validates persisted dates and timezones without relying on workout count', () => {
  const p = plan()
  p.snapshot.workouts = []
  expect(planReminderEvent(p, at('2090-01-21'))).not.toBeNull()
  p.snapshot.constraints.timezone = 'invalid/timezone'
  expect(() => planReminderEvent(p, at('2090-01-21'))).toThrow()
  p.snapshot.constraints.timezone = 'UTC'
  p.snapshot.detailWindow.endDate = '2090-02-30'
  expect(() => planReminderEvent(p, at('2090-01-21'))).toThrow()
})

it('does not suggest a refresh rejected by a changed goal horizon', () => {
  const p = plan()
  p.goalTargetDate = '2090-04-30'
  expect(planReminderEvent(p, at('2090-01-21'))).toBeNull()
})
