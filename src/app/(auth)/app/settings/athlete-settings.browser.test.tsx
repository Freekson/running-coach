// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MeasurementSystemProvider } from '../measurement-system-provider'
import { NavigationGuardProvider, useNavigationGuard } from '../navigation-guard'
import { AthleteSettings } from './athlete-settings'

const { refreshProfile, notify } = vi.hoisted(() => ({
  refreshProfile: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/components/ui/Toast', () => ({ useToast: () => notify }))

const requestId = '969e52dd-3b4f-48ce-935a-3ad674584a24'
const initial = {
  profile: {
    displayName: null,
    birthDate: null,
    sex: 'FEMALE',
    heightCm: 170,
    experienceLevel: 'BEGINNER',
    measurementSystem: 'METRIC',
    defaultTrainingDaysPerWeek: 3,
    defaultAvailableWeekdays: null,
  },
  weights: [
    {
      id: 'reading-old',
      measuredAt: '2026-11-06T12:00:00.000Z',
      measuredOn: null,
      createdAt: '2026-11-06T12:00:00.000Z',
      valueKg: 69,
    },
  ],
  chartWeights: [
    {
      id: 'reading-old',
      measuredAt: '2026-11-06T12:00:00.000Z',
      measuredOn: null,
      createdAt: '2026-11-06T12:00:00.000Z',
      valueKg: 69,
    },
  ],
} satisfies Parameters<typeof AthleteSettings>[0]['initial']
let host: HTMLDivElement
let root: Root
let leave: ReturnType<typeof vi.fn>
let awaitedGuard: { token: string; resolve: () => void } | null = null

function observePopState(event: PopStateEvent) {
  if (!awaitedGuard || event.state?.__runningCoachUnsavedChangesBase !== awaitedGuard.token) return
  awaitedGuard.resolve()
  awaitedGuard = null
}

async function moveHistory(delta: number) {
  await act(async () => {
    const token = window.history.state?.__runningCoachUnsavedChangesBase as string
    const popState = new Promise<void>((resolve) => {
      awaitedGuard = { token, resolve }
    })
    window.history.go(delta)
    await popState
  })
}

function NavigationProbe() {
  const { requestLeave } = useNavigationGuard()
  return <button onClick={() => !requestLeave(leave) && leave()}>Leave settings</button>
}

HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute('open', '')
}
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute('open')
}

function setInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function chooseDate(id: string, date: string) {
  const [year, month, day] = date.split('-').map(Number)
  act(() => host.querySelector<HTMLButtonElement>(`#${id}`)!.click())
  const calendar = host.querySelector<HTMLElement>(`#${id}-calendar`)!
  const monthSelect = calendar.querySelector<HTMLSelectElement>('select[aria-label="Month"]')!
  const yearSelect = calendar.querySelector<HTMLSelectElement>('select[aria-label="Year"]')!
  act(() => {
    monthSelect.value = String(month - 1)
    monthSelect.dispatchEvent(new Event('change', { bubbles: true }))
    yearSelect.value = String(year)
    yearSelect.dispatchEvent(new Event('change', { bubbles: true }))
  })
  act(() => calendar.querySelectorAll<HTMLButtonElement>('button[aria-label]')[day - 1]!.click())
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => requestId) })
  leave = vi.fn()
  host = document.createElement('div')
  document.body.append(host)
  window.addEventListener('popstate', observePopState, { capture: true })
  root = createRoot(host)
  act(() =>
    root.render(
      <NavigationGuardProvider>
        <NavigationProbe />
        <MeasurementSystemProvider initialSystem="METRIC">
          <AthleteSettings
            onProfileSaved={refreshProfile}
            initial={initial}
            registrationName="Avery Runner"
          />
        </MeasurementSystemProvider>
      </NavigationGuardProvider>,
    ),
  )
})

afterEach(async () => {
  act(() => root.unmount())
  await new Promise((resolve) => setTimeout(resolve, 20))
  window.removeEventListener('popstate', observePopState, { capture: true })
  host.remove()
  vi.unstubAllGlobals()
})

it('renders identical initial HTML across server timezones', () => {
  const previousTimezone = process.env.TZ
  const renderSettings = () =>
    renderToString(
      <MeasurementSystemProvider initialSystem="METRIC">
        <AthleteSettings initial={initial} registrationName="Avery Runner" />
      </MeasurementSystemProvider>,
    )
  try {
    process.env.TZ = 'UTC'
    const utcHtml = renderSettings()
    process.env.TZ = 'Pacific/Kiritimati'
    expect(renderSettings()).toBe(utcHtml)
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ
    else process.env.TZ = previousTimezone
  }
})

it('shows only required male and female sex choices', () => {
  const sex = [...host.querySelectorAll<HTMLInputElement>('input[name="sex"]')]
  expect(sex.map((input) => input.value)).toEqual(['MALE', 'FEMALE'])
  expect(sex.every((input) => input.required)).toBe(true)
  expect(sex[1].checked).toBe(true)
  expect(host.querySelector('#profile-distance')).toBeNull()
  expect(host.querySelector('#profile-weight-unit')).toBeNull()
  expect(host.querySelector('#weight-unit')).toBeNull()
})

it('shows Beginner by default and saves a selected training experience', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  const trigger = host.querySelector<HTMLButtonElement>('#profile-experience')!
  expect(trigger.textContent).toContain('Beginner')
  expect(host.textContent).not.toContain('Not provided')
  expect(host.textContent).not.toContain('Training experience (optional)')
  await act(async () => trigger.click())
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(3)
  expect(host.textContent).toContain('Training consistently')
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[role="option"]:nth-child(2)')!.click(),
  )
  expect(trigger.textContent).toContain('Intermediate')
  await act(async () =>
    host
      .querySelector<HTMLFormElement>('#athlete-profile-form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  expect(fetchMock).toHaveBeenCalledWith('/api/athlete/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ experienceLevel: 'INTERMEDIATE' }),
  })
})

it('supports keyboard navigation and Escape in the experience menu', async () => {
  const trigger = host.querySelector<HTMLButtonElement>('#profile-experience')!
  await act(async () =>
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
  )
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  const options = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')]
  expect(document.activeElement).toBe(options[0])
  await act(async () =>
    options[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })),
  )
  expect(document.activeElement).toBe(options[2])
  await act(async () =>
    options[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  )
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(trigger)
})

it('allows changing the measurement system before a sex choice is saved', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  await act(async () =>
    root.render(
      <MeasurementSystemProvider key="without-sex" initialSystem="METRIC">
        <AthleteSettings initial={{ ...initial, profile: { ...initial.profile, sex: null } }} />
      </MeasurementSystemProvider>,
    ),
  )
  const imperial = host.querySelector<HTMLInputElement>('input[value="IMPERIAL"]')!
  expect(imperial.disabled).toBe(false)
  await act(async () => imperial.click())
  expect(fetchMock).toHaveBeenCalledWith('/api/athlete/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ measurementSystem: 'IMPERIAL' }),
  })
  expect(host.querySelector<HTMLInputElement>('input[value="IMPERIAL"]')?.checked).toBe(true)
})

it('prefills the registered name, omits timezone, and requires height only in the form', async () => {
  expect(host.querySelector<HTMLInputElement>('#profile-name')?.value).toBe('Avery Runner')
  expect(host.querySelector('#profile-timezone')).toBeNull()
  const height = host.querySelector<HTMLInputElement>('#profile-height')!
  expect(height.required).toBe(true)
  await act(async () =>
    root.render(
      <MeasurementSystemProvider initialSystem="METRIC">
        <AthleteSettings
          key="without-height"
          initial={{ ...initial, profile: { ...initial.profile, heightCm: null } }}
          registrationName="Avery Runner"
        />
      </MeasurementSystemProvider>,
    ),
  )
  expect(host.querySelector<HTMLInputElement>('#profile-height')?.checkValidity()).toBe(false)
  expect(host.textContent).not.toContain('Stored measurements stay in canonical units.')
})

it('saves only changed training defaults and leaves approved plans outside the request', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  const four = [...host.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(
    (button) => button.textContent === '4',
  )!
  await act(async () => four.click())
  await act(async () =>
    host
      .querySelector<HTMLFormElement>('#athlete-profile-form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  expect(fetchMock).toHaveBeenCalledWith('/api/athlete/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ defaultTrainingDaysPerWeek: 4 }),
  })
  expect(notify).toHaveBeenCalledWith('success', 'Changes saved.', 'athlete-profile')
  expect(host.textContent).not.toContain('Changes saved.')
  expect(refreshProfile).toHaveBeenCalledOnce()
})

it('keeps the real Forward entry after saving without adding a history step', async () => {
  window.history.replaceState({ marker: 'prior' }, '')
  window.history.pushState({ marker: 'settings' }, '')
  window.history.pushState({ marker: 'next' }, '')
  await act(async () => window.history.back())
  await vi.waitFor(() => expect(window.history.state?.marker).toBe('settings'))
  const historyLength = window.history.length
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
  const four = [...host.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(
    (button) => button.textContent === '4',
  )!
  await act(async () => four.click())
  expect(window.history.length).toBe(historyLength)
  await act(async () =>
    host
      .querySelector<HTMLFormElement>('#athlete-profile-form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  await vi.waitFor(() =>
    expect(window.history.state?.__runningCoachUnsavedChangesBase).toBeUndefined(),
  )
  expect(window.history.state?.marker).toBe('settings')
  expect(window.history.length).toBe(historyLength)
  await act(async () => window.history.forward())
  await vi.waitFor(() => expect(window.history.state?.marker).toBe('next'))
  await act(async () => window.history.back())
  await vi.waitFor(() => expect(window.history.state?.marker).toBe('settings'))
})

it('asks before browser Forward when edits are pending', async () => {
  window.history.replaceState({ marker: 'prior' }, '')
  window.history.pushState({ marker: 'settings' }, '')
  window.history.pushState({ marker: 'next' }, '')
  await act(async () => window.history.back())
  await vi.waitFor(() => expect(window.history.state?.marker).toBe('settings'))
  vi.stubGlobal('navigation', {
    get currentEntry() {
      return { index: window.history.state?.marker === 'next' ? 2 : 1 }
    },
  })
  const four = [...host.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(
    (button) => button.textContent === '4',
  )!
  await act(async () => four.click())
  await moveHistory(1)
  expect(host.querySelector('dialog[open]')?.textContent).toContain('Unsaved changes')
  expect(window.history.state?.marker).toBe('settings')

  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('dialog[open] button')]
      .find((button) => button.textContent === 'Discard changes')!
      .click(),
  )
  await vi.waitFor(() => expect(window.history.state?.marker).toBe('next'))
})

it('warns before leaving with edits and saves before continuing', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  const four = [...host.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(
    (button) => button.textContent === '4',
  )!
  await act(async () => four.click())
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Leave settings')!
      .click(),
  )
  expect(leave).not.toHaveBeenCalled()
  expect(host.querySelector('dialog[open]')?.textContent).toContain('Unsaved changes')
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('dialog[open] button')]
      .find((button) => button.textContent === 'Save changes')!
      .click(),
  )
  expect(fetchMock).toHaveBeenCalledWith('/api/athlete/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ defaultTrainingDaysPerWeek: 4 }),
  })
  await vi.waitFor(() => expect(leave).toHaveBeenCalledOnce())
  expect(host.querySelector('dialog[open]')).toBeNull()
})

it('discards edits only after confirmation and restores the height field', async () => {
  await act(async () => setInput(host.querySelector<HTMLInputElement>('#profile-height')!, '175'))
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Leave settings')!
      .click(),
  )
  expect(leave).not.toHaveBeenCalled()
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('dialog[open] button')]
      .find((button) => button.textContent === 'Discard changes')!
      .click(),
  )
  await vi.waitFor(() => expect(leave).toHaveBeenCalledOnce())
  expect(host.querySelector<HTMLInputElement>('#profile-height')?.value).toBe('170.00')
  expect(
    host.querySelector<HTMLButtonElement>('button[form="athlete-profile-form"]')?.disabled,
  ).toBe(true)
})

it('keeps edits on close and prevents leaving when save fails', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  const four = [...host.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(
    (button) => button.textContent === '4',
  )!
  await act(async () => four.click())
  const leaveButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Leave settings',
  )!
  await act(async () => leaveButton.click())
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('dialog[open] button[aria-label="Close dialog"]')!
      .click(),
  )
  expect(leave).not.toHaveBeenCalled()
  expect(four.getAttribute('aria-pressed')).toBe('true')
  await act(async () => leaveButton.click())
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('dialog[open] button')]
      .find((button) => button.textContent === 'Save changes')!
      .click(),
  )
  expect(leave).not.toHaveBeenCalled()
  expect(host.querySelector('dialog[open]')?.textContent).toContain('could not be saved')
  expect(refreshProfile).not.toHaveBeenCalled()
})

it('allows leaving without a warning after a change is reverted', async () => {
  const days = [...host.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')]
  const four = days.find((button) => button.textContent === '4')!
  const three = days.find((button) => button.textContent === '3')!
  await act(async () => four.click())
  await act(async () => three.click())
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Leave settings')!
      .click(),
  )
  expect(leave).toHaveBeenCalledOnce()
  expect(host.querySelector('dialog[open]')).toBeNull()
})

it('uses the browser warning for a tab close while edits are pending', async () => {
  const four = [...host.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(
    (button) => button.textContent === '4',
  )!
  const cleanUnload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(cleanUnload)
  expect(cleanUnload.defaultPrevented).toBe(false)
  await act(async () => four.click())
  const dirtyUnload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(dirtyUnload)
  expect(dirtyUnload.defaultPrevented).toBe(true)
})

it('asks before browser Back and keeps edits when the dialog is dismissed', async () => {
  window.history.replaceState({ marker: 'prior' }, '')
  window.history.pushState({ marker: 'settings' }, '')
  const four = [...host.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(
    (button) => button.textContent === '4',
  )!
  await act(async () => four.click())
  await moveHistory(-1)
  expect(host.querySelector('dialog[open]')?.textContent).toContain('Unsaved changes')
  expect(four.getAttribute('aria-pressed')).toBe('true')

  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('dialog[open] button[aria-label="Close dialog"]')!
      .click(),
  )
  expect(host.querySelector('dialog[open]')).toBeNull()
  expect(four.getAttribute('aria-pressed')).toBe('true')

  await moveHistory(-1)
  expect(host.querySelector('dialog[open]')?.textContent).toContain('Unsaved changes')
  const guardToken = window.history.state?.__runningCoachUnsavedChangesBase

  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('dialog[open] button')]
      .find((button) => button.textContent === 'Discard changes')!
      .click(),
  )
  await vi.waitFor(() => expect(four.getAttribute('aria-pressed')).toBe('false'))
  expect(host.querySelector('dialog[open]')).toBeNull()
  await vi.waitFor(() =>
    expect(window.history.state?.__runningCoachUnsavedChangesBase).not.toBe(guardToken),
  )
  await vi.waitFor(() => expect(window.history.state?.marker).toBe('prior'))
})

it('saves profile edits before continuing browser Back', async () => {
  window.history.replaceState({ marker: 'prior' }, '')
  window.history.pushState({ marker: 'settings' }, '')
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  const four = [...host.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(
    (button) => button.textContent === '4',
  )!
  await act(async () => four.click())
  await moveHistory(-1)
  expect(host.querySelector('dialog[open]')?.textContent).toContain('Unsaved changes')
  const guardToken = window.history.state?.__runningCoachUnsavedChangesBase

  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('dialog[open] button')]
      .find((button) => button.textContent === 'Save changes')!
      .click(),
  )
  expect(fetchMock).toHaveBeenCalledWith('/api/athlete/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ defaultTrainingDaysPerWeek: 4 }),
  })
  expect(host.querySelector('dialog[open]')).toBeNull()
  expect(four.getAttribute('aria-pressed')).toBe('true')
  await vi.waitFor(() =>
    expect(window.history.state?.__runningCoachUnsavedChangesBase).not.toBe(guardToken),
  )
  await vi.waitFor(() => expect(window.history.state?.marker).toBe('prior'))
})

it('preserves intermediate history after a canceled multi-step Back', async () => {
  const originalUrl = window.location.href
  window.history.replaceState({ marker: 'dashboard' }, '', '/app/dashboard')
  window.history.pushState({ marker: 'training' }, '', '/app/training')
  window.history.pushState({ marker: 'settings' }, '', '/app/settings')
  const four = [...host.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(
    (button) => button.textContent === '4',
  )!
  await act(async () => four.click())
  const historyLength = window.history.length
  await moveHistory(-2)
  expect(window.location.pathname).toBe('/app/settings')
  expect(window.history.length).toBe(historyLength)
  expect(host.querySelector('dialog[open]')?.textContent).toContain('Unsaved changes')
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('dialog[open] button[aria-label="Close dialog"]')!
      .click(),
  )
  expect(window.location.pathname).toBe('/app/settings')
  expect(window.history.length).toBe(historyLength)
  await moveHistory(-2)
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('dialog[open] button')]
      .find((button) => button.textContent === 'Discard changes')!
      .click(),
  )
  await vi.waitFor(() => expect(window.location.pathname).toBe('/app/dashboard'))
  expect(window.history.state?.marker).toBe('dashboard')
  expect(window.history.length).toBe(historyLength)
  window.history.replaceState(null, '', originalUrl)
})

it('stays on settings when required fields are missing during modal save', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  await act(async () =>
    root.render(
      <NavigationGuardProvider>
        <NavigationProbe />
        <MeasurementSystemProvider initialSystem="METRIC">
          <AthleteSettings
            key="missing-height"
            initial={{ ...initial, profile: { ...initial.profile, heightCm: null } }}
          />
        </MeasurementSystemProvider>
      </NavigationGuardProvider>,
    ),
  )
  const four = [...host.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(
    (button) => button.textContent === '4',
  )!
  await act(async () => four.click())
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Leave settings')!
      .click(),
  )
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('dialog[open] button')]
      .find((button) => button.textContent === 'Save changes')!
      .click(),
  )
  expect(fetchMock).not.toHaveBeenCalled()
  expect(leave).not.toHaveBeenCalled()
  expect(host.textContent).toContain('Complete the required fields before saving.')
})

it('saves one account-wide system automatically and updates the weight display', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => host.querySelector<HTMLInputElement>('input[value="IMPERIAL"]')!.click())
  expect(fetchMock).toHaveBeenCalledWith('/api/athlete/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ measurementSystem: 'IMPERIAL' }),
  })
  expect(host.textContent).toContain('152.1 lb')
  expect(host.textContent).toContain('Miles (mi)')
  expect(host.querySelector<HTMLInputElement>('input[value="IMPERIAL"]')?.checked).toBe(true)
})

it('keeps unsaved training preferences when the measurement system changes', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  const four = [...host.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(
    (button) => button.textContent === '4',
  )!
  await act(async () => four.click())
  await act(async () => host.querySelector<HTMLInputElement>('input[value="IMPERIAL"]')!.click())
  expect(four.getAttribute('aria-pressed')).toBe('true')
  expect(
    host.querySelector<HTMLButtonElement>('button[form="athlete-profile-form"]')?.disabled,
  ).toBe(false)
  await act(async () =>
    host
      .querySelector<HTMLFormElement>('#athlete-profile-form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body))).toEqual([
    { measurementSystem: 'IMPERIAL' },
    { defaultTrainingDaysPerWeek: 4 },
  ])
})

it('keeps the previous system if the server rejects the switch', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })))
  await act(async () => host.querySelector<HTMLInputElement>('input[value="IMPERIAL"]')!.click())
  expect(host.querySelector<HTMLInputElement>('input[value="METRIC"]')!.checked).toBe(true)
  expect(host.textContent).toContain('Measurement system could not be saved')
  expect(host.querySelector<HTMLInputElement>('input[value="METRIC"]')?.checked).toBe(true)
})

it('records a dated weight in the global unit and preserves earlier readings', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      id: 'reading-new',
      measuredAt: '2026-11-05T12:00:00.000Z',
      createdAt: '2026-11-07T12:00:00.000Z',
      valueKg: 70,
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Add weight'))!
      .click(),
  )
  expect(host.querySelector('dialog[open]')).not.toBeNull()
  expect(host.querySelector('dialog[open]')?.textContent).not.toContain(
    'Record a new weight measurement.',
  )
  const value = host.querySelector<HTMLInputElement>('#weight-value')!
  await act(async () => {
    setInput(value, '70')
  })
  chooseDate('weight-date', '2026-11-05')
  await act(async () =>
    host
      .querySelector<HTMLFormElement>('#weight-reading-form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  expect(fetchMock).toHaveBeenCalledWith('/api/athlete/weight', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      value: 70,
      unit: 'KG',
      measuredOn: '2026-11-05',
      timezoneOffsetMinutes: new Date(2026, 10, 5, 12).getTimezoneOffset(),
      requestId,
    }),
  })
  expect(host.textContent).toContain('70.0 kg')
  expect(host.textContent).toContain('69.0 kg')
  expect(host.querySelectorAll('ol li')).toHaveLength(2)
  expect(host.textContent).not.toContain('Weight recorded.')
})

it('keeps both newly added readings in the chart during one session', async () => {
  const today = new Date()
  const earlier = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 2)
  const dateKey = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  vi.mocked(crypto.randomUUID)
    .mockReturnValueOnce('969e52dd-3b4f-48ce-935a-3ad674584a24')
    .mockReturnValueOnce('d918c356-ae38-4ac6-8196-97d21a6742f1')
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        id: 'new-earlier',
        measuredAt: new Date(
          earlier.getFullYear(),
          earlier.getMonth(),
          earlier.getDate(),
          12,
        ).toISOString(),
        createdAt: today.toISOString(),
        valueKg: 70,
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        id: 'new-today',
        measuredAt: new Date(
          today.getFullYear(),
          today.getMonth(),
          today.getDate(),
          12,
        ).toISOString(),
        createdAt: today.toISOString(),
        valueKg: 72,
      }),
    )
  vi.stubGlobal('fetch', fetchMock)

  for (const [date, value] of [
    [dateKey(earlier), '70'],
    [dateKey(today), '72'],
  ]) {
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes('Add weight'))!
        .click(),
    )
    await act(async () => setInput(host.querySelector<HTMLInputElement>('#weight-value')!, value))
    chooseDate('weight-date', date)
    await act(async () =>
      host
        .querySelector<HTMLFormElement>('#weight-reading-form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    )
  }

  expect(host.querySelector('button[aria-label*="70.0 kg on"]')).not.toBeNull()
  expect(host.querySelector('button[aria-label*="72.0 kg on"]')).not.toBeNull()
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('retries a failed weight save with the same request ID', async () => {
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('Network error'))
    .mockResolvedValueOnce(
      Response.json({
        id: 'reading-new',
        measuredAt: '2026-11-05T12:00:00.000Z',
        createdAt: '2026-11-07T12:00:00.000Z',
        valueKg: 70,
      }),
    )
  vi.stubGlobal('fetch', fetchMock)
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Add weight'))!
      .click(),
  )
  await act(async () => {
    setInput(host.querySelector<HTMLInputElement>('#weight-value')!, '70')
  })
  chooseDate('weight-date', '2026-11-05')
  const submit = () =>
    host
      .querySelector<HTMLFormElement>('#weight-reading-form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await act(async () => submit())
  expect(host.textContent).toContain('Weight could not be saved')
  await act(async () => submit())
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(crypto.randomUUID).toHaveBeenCalledTimes(1)
})

it('loads a selected chart period and shows only the latest reading for each day', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      items: [
        {
          id: 'day-new',
          measuredAt: new Date(2026, 10, 5, 16).toISOString(),
          createdAt: '2026-11-07T12:00:00.000Z',
          valueKg: 71,
        },
        {
          id: 'day-old',
          measuredAt: new Date(2026, 10, 5, 12).toISOString(),
          createdAt: '2026-11-06T12:00:00.000Z',
          valueKg: 70,
        },
        initial.weights[0],
      ],
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Chart period"] button')]
      .find((button) => button.textContent === '30D')!
      .click(),
  )
  expect(fetchMock).toHaveBeenCalledWith('/api/athlete/weight?view=chart&period=30D', {
    signal: expect.any(AbortSignal),
  })
  expect(host.querySelectorAll('button[aria-label*="on Nov 5, 2026"]')).toHaveLength(1)
  expect(host.querySelector('button[aria-label*="71.0 kg on Nov 5, 2026"]')).not.toBeNull()
  expect(
    host.querySelector<HTMLButtonElement>('[aria-label="Chart period"] button[aria-pressed="true"]')
      ?.textContent,
  ).toBe('30D')
})

it('shows an accessible spinner while the chart period loads', async () => {
  let resolveFetch!: (response: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve))),
  )
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Chart period"] button')]
      .find((button) => button.textContent === '30D')!
      .click(),
  )
  const loader = host.querySelector('[role="status"][aria-label="Loading chart"]')
  expect(loader).not.toBeNull()
  expect(loader?.querySelector('div[class*="trendPlot"]')).not.toBeNull()
  expect(host.textContent).not.toContain('Loading chart…')

  await act(async () => resolveFetch(Response.json({ items: initial.chartWeights })))
  expect(host.querySelector('[role="status"][aria-label="Loading chart"]')).toBeNull()
  const graph = host.querySelector('svg[viewBox="0 0 1000 240"]')?.parentElement?.parentElement
    ?.parentElement
  expect(graph?.classList.contains(loader!.classList[0])).toBe(true)
})

it('defaults to seven days and stores the selected period in a cookie', async () => {
  expect(
    host.querySelector<HTMLButtonElement>('[aria-label="Chart period"] button[aria-pressed="true"]')
      ?.textContent,
  ).toBe('7D')
  const cookieSetter = vi.spyOn(document, 'cookie', 'set')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ items: initial.chartWeights })))
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Chart period"] button')]
      .find((button) => button.textContent === '1Y')!
      .click(),
  )
  expect(cookieSetter).toHaveBeenCalledWith(
    'running-coach-weight-chart-period=1Y; Max-Age=31536000; Path=/app/settings; SameSite=Lax',
  )
  cookieSetter.mockRestore()
})

it('opens the full owner history and pages through the results', async () => {
  const fetchMock = vi.fn((url: string) =>
    Promise.resolve(
      Response.json({
        items: [
          {
            id: url.includes('page=2') ? 'second-page' : 'first-page',
            measuredAt: url.includes('page=2')
              ? '2026-10-01T12:00:00.000Z'
              : '2026-11-06T12:00:00.000Z',
            createdAt: '2026-11-07T12:00:00.000Z',
            valueKg: url.includes('page=2') ? 65 : 69,
          },
        ],
        page: url.includes('page=2') ? 2 : 1,
        pageSize: 5,
        total: 13,
        totalPages: 3,
      }),
    ),
  )
  vi.stubGlobal('fetch', fetchMock)
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'View all measurements')!
      .click(),
  )
  expect(host.querySelector('dialog[open] [aria-label="Page 1 of 3"]')).not.toBeNull()
  expect(host.querySelector('dialog[open]')?.textContent).toContain('69.0 kg')
  await act(async () =>
    host.querySelector<HTMLButtonElement>('dialog[open] button[aria-label="Next page"]')!.click(),
  )
  expect(fetchMock).toHaveBeenCalledWith('/api/athlete/weight?view=history&page=2', {
    signal: expect.any(AbortSignal),
  })
  expect(host.querySelector('dialog[open] [aria-label="Page 2 of 3"]')).not.toBeNull()
  expect(host.querySelector('dialog[open]')?.textContent).toContain('65.0 kg')
  expect(host.querySelector('dialog[open]')?.textContent).not.toContain('Latest')
})

it('keeps the history dialog mounted while its measurements load', async () => {
  let resolveFetch!: (response: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve))),
  )
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'View all measurements')!
      .click(),
  )
  const dialog = host.querySelector('dialog[open]')
  expect(dialog?.querySelector('[role="status"][aria-label="Loading measurements"]')).not.toBeNull()

  await act(async () =>
    resolveFetch(
      Response.json({
        items: [initial.weights[0]],
        page: 1,
        pageSize: 5,
        total: 1,
        totalPages: 1,
      }),
    ),
  )
  expect(host.querySelector('dialog[open]')).toBe(dialog)
  expect(dialog?.querySelector('[role="status"][aria-label="Loading measurements"]')).toBeNull()
  expect(dialog?.textContent).toContain('69.0 kg')
})

it('keeps the current history page in place while the next page loads', async () => {
  let resolveNext!: (response: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      url.includes('page=2')
        ? new Promise<Response>((resolve) => (resolveNext = resolve))
        : Promise.resolve(
            Response.json({
              items: [initial.weights[0]],
              page: 1,
              pageSize: 1,
              total: 2,
              totalPages: 2,
            }),
          ),
    ),
  )
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'View all measurements')!
      .click(),
  )
  const dialog = host.querySelector('dialog[open]')!
  const firstReading = dialog.querySelector('section[aria-labelledby]')!
  const results = firstReading.parentElement!
  const nextPage = dialog.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!

  nextPage.focus()
  await act(async () => nextPage.click())
  expect(firstReading.isConnected).toBe(true)
  expect(results.getAttribute('aria-hidden')).toBe('true')
  expect(results.contains(document.activeElement)).toBe(false)
  expect(document.activeElement).toBe(results.parentElement)
  expect(dialog.querySelector('[aria-label="Loading measurements"]')).not.toBeNull()

  await act(async () =>
    resolveNext(
      Response.json({
        items: [{ ...initial.weights[0], id: 'second-page', valueKg: 68 }],
        page: 2,
        pageSize: 1,
        total: 2,
        totalPages: 2,
      }),
    ),
  )
  expect(results.getAttribute('aria-hidden')).toBe('false')
  expect(dialog.textContent).toContain('68.0 kg')
  expect(document.activeElement).toBe(dialog.querySelector('[aria-label="Page 2 of 2"]'))
})

it('groups history by measurement date, shows added time, and labels only the newest entry', async () => {
  const items = [
    {
      id: 'latest',
      measuredAt: '2026-11-07T12:00:00.000Z',
      createdAt: '2026-11-07T19:12:00.000Z',
      valueKg: 85,
    },
    {
      id: 'same-day',
      measuredAt: '2026-11-07T12:00:00.000Z',
      createdAt: '2026-11-07T18:49:00.000Z',
      valueKg: 88,
    },
    {
      id: 'earlier-day',
      measuredAt: '2026-11-06T12:00:00.000Z',
      createdAt: '2026-11-07T17:20:00.000Z',
      valueKg: 86,
    },
  ]
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(Response.json({ items, page: 1, pageSize: 5, total: 3, totalPages: 1 })),
  )
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'View all measurements')!
      .click(),
  )
  const dialog = host.querySelector('dialog[open]')!
  expect(dialog.querySelectorAll('section[aria-labelledby]')).toHaveLength(2)
  expect(dialog.textContent).toContain('Added at')
  expect(dialog.textContent).not.toContain('Measured at')
  const added = dialog.querySelector('time[datetime="2026-11-07T19:12:00.000Z"]')
  expect(added?.textContent).toBe(
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(items[0].createdAt)),
  )
  const latest = [...dialog.querySelectorAll('span')].filter(
    (span) => span.textContent === 'Latest',
  )
  expect(latest).toHaveLength(1)
  expect(latest[0].closest('li')?.querySelector('strong')?.textContent).toBe('85.0 kg')
  expect(
    [...dialog.querySelectorAll<HTMLButtonElement>('button')].some(
      (button) => button.textContent === 'Close',
    ),
  ).toBe(false)
})
