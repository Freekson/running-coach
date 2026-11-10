// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { formatLocalDay, formatLocalTime } from '@/lib/local-time'
import { HealthHistoryPanel } from './HealthHistoryPanel'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})

it('switches five date ranges independently for heart rate and sleep without a network request', async () => {
  const fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
  await act(async () =>
    root.render(
      <HealthHistoryPanel
        asOfInstant="2026-11-09T08:00:00Z"
        preferredTimezone="UTC"
        rows={[
          { date: '2025-08-01', restingHrBpm: 51, sleepDurationMs: 24_000_000 },
          { date: '2026-11-08', restingHrBpm: 53, sleepDurationMs: 25_200_000 },
        ]}
      />,
    ),
  )
  const heart = host.querySelector<HTMLElement>('[aria-labelledby="heart-rate-history-heading"]')!
  const sleep = host.querySelector<HTMLElement>('[aria-labelledby="sleep-history-heading"]')!
  const layout = sleep.parentElement!
  const summaryCards = layout.children[1]
  expect(layout.firstElementChild).toBe(sleep)
  expect(summaryCards.children[0]).toBe(heart)
  expect(summaryCards.children[1].getAttribute('aria-labelledby')).toBe('last-night-heading')
  expect(host.textContent).not.toContain('Sleep analysis')
  const heartPeriods = heart.querySelector<HTMLElement>('[aria-label="Heart rate period"]')!
  const sleepPeriods = sleep.querySelector<HTMLElement>('[aria-label="Sleep period"]')!
  const sleepModes = sleep.querySelector<HTMLElement>('[aria-label="Sleep trend metric"]')!
  const sleepSummary = sleep.querySelector<HTMLElement>('[class*="trendSummary"]')!
  expect(sleepPeriods.nextElementSibling).toBe(sleepModes)
  expect(sleepPeriods.parentElement).toBe(sleepModes.parentElement)
  expect(sleepSummary.parentElement).toBe(sleepPeriods.parentElement?.parentElement)
  expect(sleepSummary.nextElementSibling).toBe(sleepPeriods.parentElement)
  expect(sleepModes.querySelector('button[aria-pressed="true"]')?.textContent).toBe('Duration')
  expect([...heartPeriods.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
    '7D',
    '30D',
    '90D',
    '1Y',
    'All',
  ])
  expect([...sleepPeriods.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
    '7D',
    '30D',
    '90D',
    '1Y',
    'All',
  ])
  expect(heart.textContent).toContain('Oct 11')
  expect(sleep.textContent).toContain('Oct 11')
  await act(async () =>
    [...heartPeriods.querySelectorAll('button')]
      .find((button) => button.textContent === '7D')!
      .click(),
  )
  expect(heart.textContent).toContain('Nov 3')
  expect(heart.textContent).toContain('7-day average')
  expect(sleep.textContent).toContain('Oct 11')
  await act(async () =>
    [...sleepPeriods.querySelectorAll('button')]
      .find((button) => button.textContent === '90D')!
      .click(),
  )
  expect(sleep.textContent).toContain('Aug 12')
  expect(sleepSummary.textContent).toContain('90-day average duration')
  await act(async () =>
    [...sleepPeriods.querySelectorAll('button')]
      .find((button) => button.textContent === '1Y')!
      .click(),
  )
  expect(sleep.textContent).toContain('Nov 10')
  expect(sleepSummary.textContent).toContain('1-year average duration')
  expect(sleep.querySelector('svg[aria-label*="by week"]')).not.toBeNull()
  expect(sleep.querySelector('g[data-sleep-date][tabindex="0"]')).not.toBeNull()
  await act(async () =>
    [...sleepPeriods.querySelectorAll('button')]
      .find((button) => button.textContent === 'All')!
      .click(),
  )
  expect(sleep.textContent).toContain('Aug 1')
  expect(sleepSummary.textContent).toContain('All-time average duration')
  expect(sleep.querySelectorAll('svg rect')).toHaveLength(2)
  expect(heart.textContent).toContain('Nov 3')
  expect(fetchSpy).not.toHaveBeenCalled()
})

it('updates heart and sleep averages with each chart period and sleep metric', async () => {
  const fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
  const rows = [
    ...['2026-10-20', '2026-10-21', '2026-10-22'].map((date) => ({
      date,
      restingHrBpm: 70,
      sleepDurationMs: 8 * 3_600_000,
      sleepScore: 80,
    })),
    ...['2026-11-07', '2026-11-08', '2026-11-09'].map((date) => ({
      date,
      restingHrBpm: 50,
      sleepDurationMs: 6 * 3_600_000,
      sleepScore: 60,
    })),
  ]
  await act(async () =>
    root.render(
      <HealthHistoryPanel asOfInstant="2026-11-09T08:00:00Z" preferredTimezone="UTC" rows={rows} />,
    ),
  )
  const heart = host.querySelector<HTMLElement>('[aria-labelledby="heart-rate-history-heading"]')!
  const sleep = host.querySelector<HTMLElement>('[aria-labelledby="sleep-history-heading"]')!
  const heartAverage = heart.querySelectorAll('[class*="heartMetrics"] > div')[1]
  const sleepAverage = sleep.querySelector<HTMLElement>('[class*="trendSummary"]')!
  expect(heartAverage.textContent).toContain('30-day average60 bpm')
  expect(sleepAverage.textContent).toContain('7h 00m30-day average duration')
  expect(heart.textContent).not.toContain('Latest measurement')

  await act(async () => {
    heart.querySelector<HTMLButtonElement>('[aria-label="Heart rate period"] button')!.click()
    sleep.querySelector<HTMLButtonElement>('[aria-label="Sleep period"] button')!.click()
  })
  expect(heartAverage.textContent).toContain('7-day average50 bpm')
  expect(sleepAverage.textContent).toContain('6h 00m7-day average duration')

  await act(async () =>
    [...sleep.querySelectorAll<HTMLButtonElement>('[aria-label="Sleep trend metric"] button')]
      .find((button) => button.textContent === 'Score')!
      .click(),
  )
  expect(sleepAverage.textContent).toContain('60 / 1007-day average sleep score')

  await act(async () =>
    [...sleep.querySelectorAll<HTMLButtonElement>('[aria-label="Sleep period"] button')]
      .find((button) => button.textContent === '30D')!
      .click(),
  )
  expect(sleepAverage.textContent).toContain('70 / 10030-day average sleep score')
  expect(fetchSpy).not.toHaveBeenCalled()
})

it('shows empty charts without measurement tables or redundant explanatory copy', async () => {
  await act(async () =>
    root.render(
      <HealthHistoryPanel asOfInstant="2026-11-09T08:00:00Z" preferredTimezone="UTC" rows={[]} />,
    ),
  )
  expect(host.textContent).toContain('No resting heart-rate readings')
  expect(host.textContent).toContain('No sleep duration readings')
  expect(host.querySelectorAll('details, table')).toHaveLength(0)
  expect(host.textContent).not.toContain('View heart rate measurements')
  expect(host.textContent).not.toContain('View sleep history')
  expect(host.textContent).not.toContain('Missing measurements are shown as gaps')
  expect(host.textContent).not.toContain('Daily measurements · Missing days are not filled')
  expect(host.textContent).not.toContain('of 7 days')
  expect(host.textContent).not.toContain('Latest night ·')
})

it('does not plot an empty measurement as a value', async () => {
  await act(async () =>
    root.render(
      <HealthHistoryPanel
        asOfInstant="2026-11-09T08:00:00Z"
        preferredTimezone="UTC"
        rows={[
          {
            date: '2026-11-08',
            restingHrBpm: null,
            sleepDurationMs: null,
            summaryChecked: true,
            sleepChecked: false,
          },
        ]}
      />,
    ),
  )
  expect(host.querySelectorAll('svg circle[class*="dot"]')).toHaveLength(0)
  expect(host.querySelectorAll('svg rect')).toHaveLength(0)
})

it('shows round, focusable heart-rate points with date and value tooltips', async () => {
  await act(async () =>
    root.render(
      <HealthHistoryPanel
        asOfInstant="2026-11-09T08:00:00Z"
        preferredTimezone="UTC"
        rows={[
          { date: '2026-11-07', restingHrBpm: 54, sleepDurationMs: null },
          { date: '2026-11-08', restingHrBpm: null, sleepDurationMs: null },
          { date: '2026-11-09', restingHrBpm: 56, sleepDurationMs: null },
        ]}
      />,
    ),
  )
  const heart = host.querySelector<HTMLElement>('[aria-labelledby="heart-rate-history-heading"]')!
  const points = heart.querySelectorAll<HTMLButtonElement>('button[data-heart-date]')
  expect(points).toHaveLength(2)
  expect(heart.querySelectorAll('svg circle')).toHaveLength(0)
  expect(points[0].getAttribute('aria-label')).toBe('Nov 7, 2026: 54 bpm')
  expect(points[0].querySelector('[aria-hidden="true"]')?.textContent).toBe('54 bpmNov 7, 2026')
  expect(points[0].style.left).toMatch(/%$/)
  expect(points[0].style.top).toMatch(/%$/)
  points[0].focus()
  expect(document.activeElement).toBe(points[0])
})

it('marks a failed sleep date without adding an invented chart value', async () => {
  await act(async () =>
    root.render(
      <HealthHistoryPanel
        asOfInstant="2026-11-09T08:00:00Z"
        preferredTimezone="UTC"
        rows={[
          {
            date: '2026-11-07',
            restingHrBpm: 55,
            sleepDurationMs: null,
            summaryChecked: true,
            sleepChecked: false,
          },
        ]}
      />,
    ),
  )
  expect(host.querySelectorAll('svg rect')).toHaveLength(0)
})

it('stacks verified sleep stages light, deep, REM and awake, and switches to scores locally', async () => {
  const fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
  await act(async () =>
    root.render(
      <HealthHistoryPanel
        asOfInstant="2026-11-09T08:00:00Z"
        preferredTimezone="UTC"
        rows={[
          {
            date: '2026-11-08',
            restingHrBpm: 53,
            sleepDurationMs: 25_200_000,
            sleepLightMs: 14_400_000,
            sleepDeepMs: 5_400_000,
            sleepRemMs: 5_400_000,
            sleepAwakeMs: 1_200_000,
            sleepScore: 82,
            sleepStartedAt: '2026-11-07T22:00:00Z',
            sleepEndedAt: '2026-11-08T05:20:00Z',
            sleepTimezone: 'UTC',
          },
        ]}
      />,
    ),
  )
  const segments = [...host.querySelectorAll<SVGRectElement>('g[data-sleep-date] rect')]
  expect(segments.map((segment) => segment.dataset.stage)).toEqual([
    'light',
    'deep',
    'rem',
    'awake',
  ])
  expect(segments.map((segment) => Number(segment.getAttribute('y')))).toEqual(
    [...segments.map((segment) => Number(segment.getAttribute('y')))].sort((a, b) => b - a),
  )
  expect(host.textContent).toContain('82')
  expect(host.textContent).toContain(formatLocalTime('2026-11-07T22:00:00Z'))
  expect(host.textContent).toContain(formatLocalDay('2026-11-07T22:00:00Z'))
  expect(host.textContent).not.toContain('Times shown in your local time zone.')
  expect(host.querySelector('[role="tooltip"]')).toBeNull()
  const sleepBar = host.querySelector<SVGGElement>('g[data-sleep-date="2026-11-08"]')!
  await act(async () => sleepBar.dispatchEvent(new Event('pointerover', { bubbles: true })))
  expect(host.querySelector('[role="tooltip"]')).not.toBeNull()
  await act(async () => sleepBar.dispatchEvent(new Event('pointerout', { bubbles: true })))
  expect(host.querySelector('[role="tooltip"]')).toBeNull()
  await act(async () => sleepBar.focus())
  const tooltip = host.querySelector<HTMLElement>('[role="tooltip"]')!
  expect(tooltip.textContent).toContain('Nov 8, 2026')
  expect(tooltip.textContent).toContain('Total sleep7h 00m')
  expect(tooltip.textContent).toContain('Light sleep4h 00m')
  expect(tooltip.textContent).toContain('Deep sleep1h 30m')
  expect(tooltip.textContent).toContain('REM sleep1h 30m')
  expect(tooltip.textContent).toContain('Awake0h 20m')
  expect(tooltip.textContent).toContain('Sleep score82')
  expect(sleepBar.getAttribute('aria-describedby')).toBe('sleep-duration-tooltip')
  await act(async () => sleepBar.dispatchEvent(new Event('pointerout', { bubbles: true })))
  expect(host.querySelector('[role="tooltip"]')).not.toBeNull()
  const scoreButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Score',
  )!
  await act(async () => scoreButton.click())
  expect(scoreButton.getAttribute('aria-pressed')).toBe('true')
  expect(host.querySelectorAll('g[data-sleep-date] rect')).toHaveLength(0)
  expect(host.querySelector('[role="tooltip"]')).toBeNull()
  expect(host.querySelector('svg[aria-label*="Sleep score"] title')).toBeNull()
  expect(fetchSpy).not.toHaveBeenCalled()
})

it('shows an unavailable stage breakdown without inventing durations and labels weekly averages', async () => {
  await act(async () =>
    root.render(
      <HealthHistoryPanel
        asOfInstant="2026-11-09T08:00:00Z"
        preferredTimezone="UTC"
        rows={[
          { date: '2026-11-07', restingHrBpm: null, sleepDurationMs: 21_600_000 },
          { date: '2026-11-08', restingHrBpm: null, sleepDurationMs: 28_800_000 },
        ]}
      />,
    ),
  )
  const sleep = host.querySelector<HTMLElement>('[aria-labelledby="sleep-history-heading"]')!
  await act(async () =>
    sleep.querySelector<SVGGElement>('g[data-sleep-date="2026-11-07"]')!.focus(),
  )
  expect(sleep.querySelector('[role="tooltip"]')?.textContent).toContain(
    'Stage breakdown unavailable',
  )
  expect(sleep.querySelector('[role="tooltip"]')?.textContent).not.toContain('Light sleep')
  await act(async () =>
    [...sleep.querySelectorAll<HTMLButtonElement>('[aria-label="Sleep period"] button')]
      .find((button) => button.textContent === '1Y')!
      .click(),
  )
  const weeklyBar = sleep.querySelector<SVGGElement>('g[data-sleep-date="2026-11-08"]')!
  await act(async () => weeklyBar.focus())
  expect(sleep.querySelector('[role="tooltip"]')?.textContent).toContain('7-day average ending')
  expect(sleep.querySelector('[role="tooltip"]')?.textContent).toContain('Total sleep7h 00m')
})

it('leaves an old night unsegmented when stage totals are missing or inconsistent', async () => {
  await act(async () =>
    root.render(
      <HealthHistoryPanel
        asOfInstant="2026-11-09T08:00:00Z"
        preferredTimezone="UTC"
        rows={[
          { date: '2026-11-07', restingHrBpm: null, sleepDurationMs: 25_200_000 },
          {
            date: '2026-11-08',
            restingHrBpm: null,
            sleepDurationMs: 25_200_000,
            sleepLightMs: 50_000_000,
            sleepDeepMs: 3_600_000,
            sleepRemMs: 3_600_000,
            sleepAwakeMs: 0,
          },
        ]}
      />,
    ),
  )
  expect(host.querySelectorAll('g[data-sleep-date] rect[data-stage]')).toHaveLength(0)
  expect(host.querySelectorAll('g[data-sleep-date] rect')).toHaveLength(2)
  expect(host.textContent).toContain('Stage breakdown is unavailable for this night.')
})
