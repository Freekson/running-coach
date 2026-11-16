// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ExportSetup } from '@/lib/plan-export'
import { PlanExportScreen } from './plan-export'
import requestFixture from '@/../docs/fixtures/plan-exchange-v1/no-garmin-account.request.json'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const setup: ExportSetup = {
  goalName: 'Synthetic trail goal',
  goalDate: '2027-01-01',
  draftId: '00000000-0000-4000-8000-000000000001',
  version: 0,
  measurementSystem: 'METRIC',
  today: '2026-11-16',
  constraints: {
    sessionsPerWeek: 3,
    availableWeekdays: [1, 3, 6],
    maxSessionMinutes: 60,
    startDate: null,
    timezone: 'Asia/Tokyo',
  },
}
const artifact = {
  requestId: 'synthetic-request',
  json: JSON.stringify({ request: requestFixture }),
  prompt: 'Synthetic exact prompt',
  bytes: 80,
}
let root: Root, container: HTMLDivElement
const onPreview = vi.fn(),
  onOpen = vi.fn(),
  onSchedule = vi.fn()
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  onPreview.mockResolvedValue({ success: true, value: artifact })
  await act(async () =>
    root.render(
      <PlanExportScreen
        goalId="synthetic-goal"
        goalName={setup.goalName}
        initialSetup={setup}
        onOpen={onOpen}
        onPreview={onPreview}
        onSchedule={onSchedule}
      />,
    ),
  )
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
const button = (text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === text)!
const checkbox = (text: string) =>
  [...container.querySelectorAll('label')]
    .find((l) => l.textContent?.includes(text))!
    .querySelector('input')!
async function click(el: HTMLElement) {
  await act(async () => el.click())
}
async function preview() {
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
}

it('starts with explicit opt-outs and prepares unknown background without mandatory questions', async () => {
  expect(
    [...container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].filter(
      (el) => el.checked,
    ),
  ).toHaveLength(3)
  expect(container.querySelector('#experience')).toBeNull()
  expect(button('Copy Prompt')).toBeUndefined()
  await preview()
  expect(onPreview).toHaveBeenCalledWith(
    expect.objectContaining({
      consent: {
        recordedActivityMetrics: false,
        activityHeartRate: false,
        recordedLaps: false,
        athleteReport: false,
        limitationsOrFatigue: false,
        recovery: false,
      },
    }),
  )
  expect(onPreview.mock.calls[0][0].background).toBeUndefined()
  expect(container.textContent).toContain('Missing Garmin records do not prove inactivity')
})
it('preserves approved constraints when the legacy goal export opens a refresh', async () => {
  await act(async () =>
    root.render(
      <PlanExportScreen
        key="refresh"
        goalId="synthetic-goal"
        goalName={setup.goalName}
        initialSetup={{ ...setup, mode: 'refresh' }}
        onOpen={onOpen}
        onPreview={onPreview}
        onSchedule={onSchedule}
      />,
    ),
  )
  expect(container.querySelector('#sessions')).toBeNull()
  expect(container.querySelector('#plan-start')).toBeNull()
  expect(container.querySelector('#detail-start')).not.toBeNull()
  expect(container.textContent).toContain('Saved constraints: 3 sessions per week')
  await preview()
  expect(onSchedule).not.toHaveBeenCalled()
  expect(onPreview).toHaveBeenCalledWith(
    expect.objectContaining({ draftId: setup.draftId, expectedVersion: setup.version }),
  )
})
it('invalidates the previous export immediately when consent changes', async () => {
  await preview()
  expect(button('Copy Prompt')).toBeDefined()
  await click(checkbox('Include my optional training background'))
  expect(button('Copy Prompt')).toBeUndefined()
  expect(container.querySelector('#experience')).not.toBeNull()
  await preview()
  expect(onPreview.mock.calls.at(-1)![0].background.experience).toBe('unknown')
  expect(onPreview.mock.calls.at(-1)![0].background.firstWorkoutEver).toBeNull()
  await click(checkbox('Include my optional training background'))
  await preview()
  expect(onPreview.mock.calls.at(-1)![0].background).toBeUndefined()
})
it('copies the full prompt, downloads exactly the preview JSON and supports clipboard failure', async () => {
  const copy = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
  await preview()
  await click(button('Copy Prompt'))
  expect(copy).toHaveBeenCalledWith(artifact.prompt)
  copy.mockRejectedValue(new Error('denied'))
  await click(button('Copy Prompt'))
  expect(container.querySelector('[role=alert]')?.textContent).toContain('Select and copy')
  expect(container.querySelector<HTMLTextAreaElement>('#copy-prompt')?.value).toBe(artifact.prompt)
  const objectUrl = vi.fn().mockReturnValue('blob:synthetic')
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: objectUrl })
  const revoke = vi.fn()
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  await click(button('Download JSON'))
  expect(objectUrl.mock.calls[0][0].type).toBe('application/json')
  expect(download.mock.instances[0]).toMatchObject({
    download: 'plan-request-synthetic-request.json',
  })
  download.mockRestore()
})
it('shows safe errors and disables the action during a pending preview', async () => {
  let resolve!: (value: unknown) => void
  onPreview.mockReturnValue(
    new Promise((r) => {
      resolve = r
    }),
  )
  await preview()
  expect(button('Prepare export preview').disabled).toBe(true)
  await act(async () => resolve({ success: false, error: 'Reload the draft.' }))
  expect(container.querySelector('[role=alert]')?.textContent).toBe('Reload the draft.')
  expect(button('Copy Prompt')).toBeUndefined()
})
