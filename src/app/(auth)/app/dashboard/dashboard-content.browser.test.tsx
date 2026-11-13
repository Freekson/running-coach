// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { buildDashboardWeeks } from '@/lib/dashboard'
import type { ActivityHistoryRow } from '@/lib/activity-history'
import { DashboardContent, type DashboardContentProps } from './dashboard-content'
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const asOfInstant = '2026-11-13T10:00:00.000Z'
const activity: ActivityHistoryRow = {
  id: 'synthetic-a',
  title: 'Evening run',
  sport: 'RUNNING',
  sourceSport: null,
  provider: 'GARMIN',
  startedAt: '2026-11-12T09:00:00Z',
  distanceMeters: 5000,
  timerMs: 1_800_000,
  movingMs: null,
  elapsedMs: null,
  avgSpeedMps: null,
  avgHrBpm: 150,
}
const props: DashboardContentProps = {
  asOfInstant,
  name: 'Alex Runner',
  timezone: 'Asia/Tokyo',
  system: 'METRIC',
  overview: {
    weeks: buildDashboardWeeks([activity], asOfInstant, 'Asia/Tokyo'),
    timezone: 'Asia/Tokyo',
  },
  recent: [activity],
  health: {
    restingHr: null,
    sleep: null,
    restingHrChecked: false,
    sleepChecked: false,
    lastUpdatedAt: null,
  },
  sync: null,
}
let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})

it('renders the persisted overview, independent HR labels and existing detail/navigation routes without provider requests', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<DashboardContent {...props} />))
  expect(host.textContent).toContain('Good evening, Alex')
  expect(host.textContent).toContain('5.00 km')
  expect(host.textContent).toContain('150 bpm')
  expect(host.textContent).toContain('Resting HR')
  expect(host.textContent).toContain('Avg HR')
  expect(host.textContent).toContain('Not checked yet')
  expect(host.textContent).toContain('No workout scheduled yet')
  expect(host.querySelector('a[href="/app/training/synthetic-a"]')).not.toBeNull()
  expect(host.querySelector('a[href="/app/training"]')).not.toBeNull()
  expect(host.querySelector('a[href="/app/health"]')).not.toBeNull()
  expect(fetchMock).not.toHaveBeenCalled()
})

it('changes chart metrics and exposes keyboard-readable week values without fetching Garmin', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<DashboardContent {...props} />))
  for (const label of ['Time', 'Runs', 'Distance']) {
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === label)!
    await act(async () => button.click())
    expect(button.getAttribute('aria-pressed')).toBe('true')
  }
  const weeks = [...host.querySelectorAll<HTMLButtonElement>('button[aria-label*="current week"]')]
  expect(weeks).toHaveLength(1)
  expect(weeks[0].getAttribute('aria-label')).toContain('5.00 km')
  expect(host.textContent).toContain('Current week')
  expect(host.textContent).not.toContain('in progress')
  expect(fetchMock).not.toHaveBeenCalled()
})

it('clears the chart highlight and restores current-week statistics after hover or keyboard focus leaves', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<DashboardContent {...props} />))
  const chart = host.querySelector<HTMLElement>(
    '[aria-label="Running distance for the last eight calendar weeks"]',
  )!
  const previousWeek = chart.querySelector('button')!
  const readout = () =>
    host
      .querySelector('#training-progress-heading')!
      .closest('section')!
      .querySelector('[role="status"]')!.textContent
  expect(chart.querySelector('[aria-pressed="true"]')).toBeNull()
  expect(readout()).toContain('5.00 km')
  await act(async () =>
    previousWeek.dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }),
    ),
  )
  expect(previousWeek.getAttribute('aria-pressed')).toBe('true')
  expect(readout()).not.toContain('Current week')
  // Clicking also focuses a bar in browsers; leaving must still clear its preview.
  await act(async () => {
    previousWeek.focus()
    previousWeek.click()
  })
  await act(async () =>
    chart.dispatchEvent(
      new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }),
    ),
  )
  expect(chart.querySelector('[aria-pressed="true"]')).toBeNull()
  expect(readout()).toContain('5.00 km')
  expect(readout()).toContain('Current week')
  await act(async () => {
    previousWeek.blur()
    previousWeek.focus()
  })
  expect(previousWeek.getAttribute('aria-pressed')).toBe('true')
  await act(async () => previousWeek.blur())
  expect(chart.querySelector('[aria-pressed="true"]')).toBeNull()
  expect(readout()).toContain('5.00 km')
  expect(fetchMock).not.toHaveBeenCalled()
})

it('keeps each section usable when another read fails and works without activities or health', async () => {
  await act(async () => root.render(<DashboardContent {...props} overview={null} health={null} />))
  expect(host.textContent).toContain('Training overview unavailable')
  expect(host.textContent).toContain('Health snapshot unavailable')
  expect(host.textContent).toContain('Evening run')
  await act(async () =>
    root.render(
      <DashboardContent
        {...props}
        overview={{ ...props.overview!, weeks: buildDashboardWeeks([], asOfInstant, 'UTC') }}
        recent={[]}
      />,
    ),
  )
  expect(host.textContent).toContain('No runs in the last 8 weeks')
  expect(host.textContent).toContain('No activities yet')
  expect(host.textContent).not.toContain('0 bpm')
})

it('keeps resting HR optional independently from workout HR, with a compact stale status', () => {
  const markup = renderToStaticMarkup(
    <DashboardContent
      {...props}
      recent={[{ ...activity, avgHrBpm: null }]}
      health={{
        ...props.health!,
        restingHrChecked: true,
        restingHr: {
          value: 52,
          date: '2026-10-01',
          timezone: 'Asia/Tokyo',
          fetchedAt: asOfInstant,
        },
      }}
    />,
  )
  expect(markup).toContain('52 bpm')
  expect(markup).not.toContain('2026-10-01')
  expect(markup).not.toContain('Date timezone')
  expect(markup).not.toContain('Asia/Tokyo')
  expect(markup).not.toContain('Last Garmin health check')
  expect(markup).not.toContain('Running totals use saved activities only')
  expect(markup).toContain('Older reading')
  expect(markup).toContain('Avg HR')
})

it('honors imperial units and stays deterministic for the captured server clock', () => {
  const first = renderToStaticMarkup(<DashboardContent {...props} system="IMPERIAL" />)
  expect(first).toContain('3.11 mi')
  expect(first).toContain('/mi')
  expect(first).toBe(renderToStaticMarkup(<DashboardContent {...props} system="IMPERIAL" />))
})
