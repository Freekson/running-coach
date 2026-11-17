// @vitest-environment jsdom
import { act, type ReactNode, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NavigationGuardProvider } from '../navigation-guard'
import { MeasurementSystemProvider } from '../measurement-system-provider'
import { AthleteSettings } from '../settings/athlete-settings'
import { PlanReminderBanner } from './plan-reminder-banner'
import { PlanReminderLink } from './plan-reminder-link'
import type { PlanReminder } from '@/lib/plan-reminders'

const mocks = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/components/ui/Toast', () => ({ useToast: () => vi.fn() }))
// Model Link's SPA navigation contract: onNavigate can prevent the navigation.
vi.mock('next/link', () => ({
  default: ({
    href,
    onNavigate,
    children,
    ...props
  }: {
    href: string
    onNavigate?: (event: { preventDefault: () => void }) => void
    children: ReactNode
  }) => (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        let prevented = false
        event.preventDefault()
        onNavigate?.({
          preventDefault: () => {
            prevented = true
          },
        })
        if (!prevented) mocks.push(href)
      }}
    >
      {children}
    </a>
  ),
}))

const initial: ComponentProps<typeof AthleteSettings>['initial'] = {
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
}
const reminder: PlanReminder = {
  planId: 'synthetic-plan',
  fingerprint: 'a'.repeat(64),
  goalName: 'Synthetic goal',
  detailEndDate: '2090-01-28',
  timezone: 'UTC',
  exhausted: false,
  refreshByDate: '2090-01-20',
  nextAction: 'refresh',
}
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute('open', '')
}
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute('open')
}
let host: HTMLDivElement, root: Root
beforeEach(() => {
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function render(nextAction: PlanReminder['nextAction'] | 'unavailable' = 'refresh') {
  await act(async () =>
    root.render(
      <NavigationGuardProvider>
        {nextAction === 'unavailable' ? (
          <PlanReminderLink href="/app/training/plan/refresh">
            Review approved plans
          </PlanReminderLink>
        ) : (
          <PlanReminderBanner
            reminder={{ ...reminder, nextAction }}
            onRespond={async () => ({ success: true })}
          />
        )}
        <MeasurementSystemProvider initialSystem="METRIC">
          <AthleteSettings initial={initial} />
        </MeasurementSystemProvider>
      </NavigationGuardProvider>,
    ),
  )
}
function button(label: string) {
  const scope = host.querySelector('dialog[open]') ?? host
  const result = [...scope.querySelectorAll('button')].find(
    (b) => b.textContent === label || b.getAttribute('aria-label') === label,
  )
  if (!result) throw new Error(`Missing button ${label}`)
  return result
}
async function editSettings() {
  const day = [...host.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(
    (b) => b.textContent === '4',
  )!
  await act(async () => day.click())
}

it.each([
  ['refresh', '/app/training/plan/refresh?planId=synthetic-plan'],
  ['review-plan', '/app/training/plan/synthetic-plan'],
  ['unavailable', '/app/training/plan/refresh'],
] as const)('guards the %s link when Settings has unsaved changes', async (action, href) => {
  await render(action)
  await editSettings()
  await act(async () => host.querySelector('a')!.click())
  expect(mocks.push).not.toHaveBeenCalled()
  expect(host.querySelector('dialog[open]')?.textContent).toContain('Unsaved changes')
  await act(async () => button('Close dialog').click())
  expect(mocks.push).not.toHaveBeenCalled()
  expect(
    [...host.querySelectorAll('button[aria-pressed="true"]')].some((b) => b.textContent === '4'),
  ).toBe(true)
  await act(async () => host.querySelector('a')!.click())
  await act(async () => button('Discard changes').click())
  expect(mocks.push).toHaveBeenCalledExactlyOnceWith(href)
})

it('saves Settings successfully before following the refresh link', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  try {
    await render()
    await editSettings()
    await act(async () => host.querySelector('a')!.click())
    await act(async () => button('Save changes').click())
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/athlete/profile',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ defaultTrainingDaysPerWeek: 4 }),
      }),
    )
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith(
      '/app/training/plan/refresh?planId=synthetic-plan',
    )
  } finally {
    vi.unstubAllGlobals()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  }
})

it('allows navigation from clean Settings without opening a dialog', async () => {
  await render()
  await act(async () => host.querySelector('a')!.click())
  expect(mocks.push).toHaveBeenCalledExactlyOnceWith(
    '/app/training/plan/refresh?planId=synthetic-plan',
  )
  expect(host.querySelector('dialog[open]')).toBeNull()
})
