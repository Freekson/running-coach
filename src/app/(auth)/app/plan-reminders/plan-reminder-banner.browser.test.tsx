// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PlanReminderBanner } from './plan-reminder-banner'
import type { PlanReminder, PlanReminderResult } from '@/lib/plan-reminders'
import { ToastProvider } from '@/components/ui/Toast'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => null,
}))
const reminder: PlanReminder = {
  planId: 'synthetic-plan',
  fingerprint: 'a'.repeat(64),
  goalName: 'Synthetic endurance goal',
  detailEndDate: '2090-01-28',
  timezone: 'Asia/Tokyo',
  exhausted: false,
  refreshByDate: '2090-03-17',
  nextAction: 'refresh',
}
let host: HTMLDivElement, root: Root
const respond = vi.fn<(command: unknown) => Promise<PlanReminderResult>>()
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  respond.mockReset().mockResolvedValue({ success: true })
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})
async function render(data: PlanReminder | null = reminder) {
  await act(async () =>
    root.render(
      <ToastProvider>
        <main id="main-content" tabIndex={-1}>
          {data && (
            <PlanReminderBanner key={data.fingerprint} reminder={data} onRespond={respond} />
          )}
        </main>
      </ToastProvider>,
    ),
  )
}
function button(text: string) {
  const result = [...host.querySelectorAll('button')].find((b) => b.textContent === text)
  if (!result) throw new Error(`Missing button ${text}`)
  return result
}

it('renders a labeled non-modal region, semantic date and direct manual-refresh CTA', async () => {
  await render()
  const section = host.querySelector('section')!
  expect(section.getAttribute('role')).toBeNull()
  expect(document.getElementById(section.getAttribute('aria-labelledby')!)?.textContent).toBe(
    'Plan your next training window',
  )
  expect(host.querySelector('time')?.dateTime).toBe('2090-01-28')
  expect(host.querySelector('a')?.getAttribute('href')).toBe(
    '/app/training/plan/refresh?planId=synthetic-plan',
  )
  expect(host.querySelector('svg')?.closest('[aria-hidden="true"]')).not.toBeNull()
  expect([...host.querySelectorAll('button')].every((b) => b.type === 'button')).toBe(true)
  expect(respond).not.toHaveBeenCalled()
})

it.each([
  ['Dismiss reminder', 'dismiss'],
  ['Snooze 24 hours', 'snooze'],
])('saves %s for this exact event and announces success', async (label, action) => {
  await render()
  button(label).focus()
  await act(async () => button(label).click())
  expect(respond).toHaveBeenCalledWith({
    planId: reminder.planId,
    fingerprint: reminder.fingerprint,
    action,
  })
  expect(host.querySelector('section')).toBeNull()
  expect(document.activeElement).toBe(host.querySelector('#main-content'))
  const message =
    action === 'dismiss'
      ? 'Reminder dismissed for this approved revision.'
      : 'Reminder snoozed for 24 hours.'
  expect(host.querySelector('[role="status"]')?.textContent).toBe(message)
  const landmark = document.activeElement
  // The revalidated server region no longer returns this saved reminder.
  await render(null)
  expect(host.querySelector('[role="status"]')?.textContent).toBe(message)
  expect(document.activeElement).toBe(landmark)
})

it.each([
  ['Dismiss reminder', 'Reminder dismissed for this approved revision.'],
  ['Snooze 24 hours', 'Reminder snoozed for 24 hours.'],
])(
  'preserves success feedback when %s is removed before the action resolves',
  async (label, message) => {
    let finish: (result: PlanReminderResult) => void = () => {}
    respond.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await render()
    button(label).focus()
    await act(async () => button(label).click())
    await render(null)
    expect(host.querySelector('section')).toBeNull()
    await act(async () => finish({ success: true }))
    expect(host.querySelector('[role="status"]')?.textContent).toBe(message)
    expect(document.activeElement).toBe(host.querySelector('#main-content'))
    await render(null)
    expect(host.querySelector('[role="status"]')?.textContent).toBe(message)
    expect(document.activeElement).toBe(host.querySelector('#main-content'))
  },
)

it('keeps failed reminders visible, announces errors and permits retry', async () => {
  respond.mockResolvedValueOnce({ success: false, error: 'Save failed. Try again.' })
  await render()
  await act(async () => button('Dismiss reminder').click())
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Save failed. Try again.')
  expect(button('Dismiss reminder').disabled).toBe(false)
  await act(async () => button('Dismiss reminder').click())
  expect(host.querySelector('section')).toBeNull()
})

it('disables controls while saving and handles transport failure without hiding the banner', async () => {
  let reject: (reason: Error) => void = () => {}
  respond.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail
      }),
  )
  await render()
  await act(async () => button('Snooze 24 hours').click())
  expect(host.querySelector('section')?.getAttribute('aria-busy')).toBe('true')
  expect([...host.querySelectorAll('button')].every((b) => b.disabled)).toBe(true)
  expect(host.querySelector('a')).toBeNull()
  await act(async () => reject(new Error('network')))
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not be saved')
  expect(host.querySelector('a')).not.toBeNull()
})

it('shows a new revision after dismissing an earlier event', async () => {
  await render()
  await act(async () => button('Dismiss reminder').click())
  await render({ ...reminder, fingerprint: 'b'.repeat(64), exhausted: true })
  expect(host.querySelector('section')?.textContent).toContain('detail ended')
})

it('shows review guidance instead of an impossible refresh after the deadline', async () => {
  await render({ ...reminder, nextAction: 'review-plan' })
  expect(host.querySelector('a')?.getAttribute('href')).toBe('/app/training/plan/synthetic-plan')
  expect(host.querySelector('a')?.textContent).toBe('Review plan')
  expect(host.textContent).toContain('A 14-day future refresh no longer fits')
  expect(host.textContent).not.toContain('Refresh by')
})
