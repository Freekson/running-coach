// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RescheduleResult } from '@/lib/training-calendar'
import { CalendarLoading } from './calendar-loading'
import { calendarFixture } from './calendar.fixtures'
import { TrainingCalendar, type TrainingCalendarProps } from './training-calendar'

let host: HTMLDivElement, root: Root
const save = vi.fn<NonNullable<TrainingCalendarProps['onReschedule']>>()
const reload = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  save.mockReset().mockResolvedValue({ success: true })
  reload.mockReset()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
async function render(props: Partial<TrainingCalendarProps> = {}) {
  await act(async () =>
    root.render(
      <TrainingCalendar
        data={calendarFixture()}
        onReschedule={save}
        onReload={reload}
        {...props}
      />,
    ),
  )
}
async function click(selector: string) {
  await act(async () => host.querySelector<HTMLButtonElement>(selector)!.click())
}

it.each([320, 375, 1440])(
  'preserves labeled sessions, status and navigation at width %i',
  async (width) => {
    vi.stubGlobal('innerWidth', width)
    await render()
    expect(host.querySelectorAll('section')).toHaveLength(7)
    const day = host.querySelector('section[aria-label="Sat, Nov 14"]')!
    expect(day.querySelectorAll('article')).toHaveLength(2)
    for (const status of [
      'Planned',
      'Completed',
      'Missed',
      'Canceled',
      'Moved from',
      'Unlinked activity',
      'Rest / recovery day',
      'Locked',
    ])
      expect(host.textContent).toContain(status)
    expect(host.querySelector('a[aria-label="Next week"]')?.getAttribute('href')).toBe(
      '/app/calendar?date=2026-11-19&view=week',
    )
    expect(
      host.querySelector('nav[aria-label="Calendar view"] [aria-current="page"]')?.textContent,
    ).toBe('Week')
    expect(host.querySelector('a[href="/app/training/saved"]')?.textContent).toContain(
      'Morning run',
    )
    expect(host.querySelector('button[aria-label="Move Completed session"]')).toBeNull()
    expect(host.querySelectorAll('button[aria-label^="Move "]')).toHaveLength(2)
  },
)
it('supports monthly navigation, empty plan and sparse history without invented sessions', async () => {
  await render({ data: calendarFixture('month') })
  expect(host.querySelectorAll('section')).toHaveLength(42)
  expect(host.querySelector('a[aria-label="Next month"]')?.getAttribute('href')).toBe(
    '/app/calendar?date=2026-12-01&view=month',
  )
  const data = calendarFixture()
  await render({
    data: {
      ...data,
      hasPlan: false,
      days: data.days.map((d) => ({ ...d, rest: false, workouts: [] })),
    },
  })
  expect(host.textContent).toContain('No approved plan yet')
  expect(host.textContent).toContain('Saved trail run')
  expect(host.textContent).not.toContain('Rest / recovery day')
  expect(host.querySelectorAll('article')).toHaveLength(1)
})
it('submits only the chosen session and its expected revision after explicit date approval', async () => {
  await render()
  await click('button[aria-label="Move Evening recovery"]')
  expect(save).not.toHaveBeenCalled()
  await click('#session-date')
  await click('button[aria-label="November 16, 2026"]')
  await click('dialog footer button:last-child')
  expect(save).toHaveBeenCalledWith({
    planId: '00000000-0000-4000-8000-000000000002',
    expectedRevisionId: '00000000-0000-4000-8000-000000000003',
    workoutId: '00000000-0000-4000-8000-000000000004',
    scheduledDate: '2026-11-16',
    timezone: 'America/New_York',
  })
  expect(host.querySelector('dialog')?.open).toBe(false)
  expect(host.querySelector('[role="status"]')?.textContent).toContain('Session moved')
})
it('keeps conflict feedback visible and offers a calendar reload', async () => {
  save.mockResolvedValue({
    success: false,
    code: 'conflict',
    error: 'The plan changed. Reload the calendar.',
  })
  await render()
  await click('button[aria-label="Move Easy run"]')
  await click('dialog footer button:last-child')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('The plan changed')
  expect(host.querySelector<HTMLButtonElement>('dialog footer button:last-child')?.disabled).toBe(
    true,
  )
  await click('[role="alert"] button')
  expect(reload).toHaveBeenCalledOnce()
})
it('disables repeated submissions and dismissal while saving', async () => {
  let resolve!: (value: RescheduleResult) => void
  save.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  await render()
  await click('button[aria-label="Move Easy run"]')
  await click('dialog footer button:last-child')
  expect(
    [...host.querySelectorAll<HTMLButtonElement>('dialog footer button')].every((b) => b.disabled),
  ).toBe(true)
  await act(async () =>
    host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })),
  )
  expect(host.querySelector('dialog')?.open).toBe(true)
  expect(save).toHaveBeenCalledOnce()
  await act(async () => resolve({ success: true }))
})
it('shows a safe retryable error on network failure and a labeled loading state', async () => {
  save.mockRejectedValue(new Error('private network error'))
  await render()
  await click('button[aria-label="Move Easy run"]')
  await click('dialog footer button:last-child')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Please try again')
  expect(host.textContent).not.toContain('private network error')
  await act(async () => root.render(<CalendarLoading />))
  expect(host.querySelector('[role="status"]')?.textContent).toContain(
    'Loading your training calendar',
  )
})

it('labels an activity linked to a session on another day without calling it unlinked', async () => {
  const data = calendarFixture()
  const day = data.days.find((d) => d.date === '2026-11-15')!
  day.rest = false
  day.activities.push({
    id: 'late-run',
    title: 'Delayed completed run',
    date: day.date,
    timezone: 'America/New_York',
    linkedWorkoutId: data.days.flatMap((d) => d.workouts)[0].id,
  })
  await render({ data })
  const actual = host.querySelector('section[aria-label="Sun, Nov 15"]')!
  expect(actual.textContent).toContain('Linked activity')
  expect(actual.textContent).not.toContain('Unlinked activity')
  expect(actual.textContent).not.toContain('Rest / recovery day')
  expect(actual.querySelector('a')?.getAttribute('href')).toBe('/app/training/late-run')
})
