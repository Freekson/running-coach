// @vitest-environment jsdom
import { act, Suspense, use, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ActivityHistory } from './activity-history'
import { MeasurementSystemProvider } from '../measurement-system-provider'
import {
  defaultActivityHistoryQuery as defaults,
  type ActivityHistoryPage,
  type ActivityHistoryQuery,
} from '@/lib/activity-history'

const { push } = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('./use-activity-timezone', () => ({
  useActivityTimezone: () => ({ timezone: 'Asia/Tokyo', ready: true }),
}))
let host: HTMLDivElement
let root: Root
const data: ActivityHistoryPage = {
  items: [
    {
      id: 'row',
      title: 'Morning Run',
      sport: 'RUNNING',
      sourceSport: 'running',
      provider: 'GARMIN',
      startedAt: '2026-11-11T16:00:00Z',
      distanceMeters: 5000,
      timerMs: 1800000,
      elapsedMs: null,
      movingMs: null,
      avgSpeedMps: null,
      avgHrBpm: null,
    },
  ],
  total: 12,
  importedCount: 12,
  page: 1,
  pageSize: 10,
  pageCount: 2,
  sports: ['RUNNING', 'WALKING'],
  providers: ['GARMIN', 'FILE'],
  timezone: 'Asia/Tokyo',
  dateBounds: { min: '2023-11-11', max: '2026-11-12' },
  imported: true,
  savedAt: null,
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  push.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
async function render(page = data, query: ActivityHistoryQuery = defaults) {
  await act(async () =>
    root.render(
      <MeasurementSystemProvider initialSystem="METRIC">
        <ActivityHistory key={JSON.stringify(query)} data={page} query={query} />
      </MeasurementSystemProvider>,
    ),
  )
}
async function select(id: string, label: string) {
  await act(async () => host.querySelector<HTMLButtonElement>(`#${id}`)!.click())
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((option) => option.textContent === label)!
      .click(),
  )
}
function typeSearch(value: string) {
  const input = host.querySelector<HTMLInputElement>('#activity-search')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
it('renders saved rows with local dates, duration semantics and unavailable HR', async () => {
  await render()
  const row = host.querySelector('tbody tr')!
  expect(row.textContent).toContain('Nov 12, 2026')
  expect(row.textContent).toContain('5.00 km')
  expect(row.textContent).toContain('Timer time')
  expect(row.textContent).toContain('6:00 /km')
  expect(row.textContent).toContain('—')
  expect(row.querySelector('a')?.getAttribute('href')).toBe(
    '/app/training/row?back=%2Fapp%2Ftraining',
  )
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Previous page"]')?.disabled).toBe(true)
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!.click())
  expect(push).toHaveBeenCalledWith('/app/training?page=2', { scroll: false })
})
it('applies composed filters through URL navigation with no provider fetch', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  await render()
  await select('activity-sport', 'Running')
  expect(push).toHaveBeenCalledOnce()
  await select('activity-range', 'Last 7 days')
  await select('activity-provider', 'File')
  const query = new URL(push.mock.lastCall![0], 'https://example.test').searchParams
  expect(Object.fromEntries(query)).toMatchObject({
    sport: 'RUNNING',
    range: '7',
    provider: 'FILE',
  })
  expect(fetchMock).not.toHaveBeenCalled()
  expect(host.textContent).not.toContain('Apply filters')
})
it('resets pagination on sorting and page-size changes and restores query state on back navigation', async () => {
  await render({ ...data, page: 2 }, { ...defaults, q: 'Trail', page: 2 })
  await select('activity-sort', 'Oldest first')
  expect(push).toHaveBeenLastCalledWith('/app/training?q=Trail&sort=oldest', { scroll: false })
  await select('activity-page-size', '25 / page')
  expect(push).toHaveBeenLastCalledWith('/app/training?q=Trail&sort=oldest&pageSize=25', {
    scroll: false,
  })
  await render(data, defaults)
  expect(host.querySelector<HTMLInputElement>('#activity-search')!.value).toBe('')
  expect(host.querySelector('#activity-sort')!.textContent).toContain('Newest first')
})
it('distinguishes not imported, an empty completed import and no matches', async () => {
  const empty = { ...data, items: [], total: 0, importedCount: 0, providers: [], sports: [] }
  await render({ ...empty, imported: false })
  expect(host.textContent).toContain('Import your activities to get started')
  expect(host.querySelector('#activity-provider')).toBeNull()
  await render({ ...empty, imported: true })
  expect(host.textContent).toContain('No activities yet')
  await render(empty, { ...defaults, q: 'Unmatched' })
  expect(host.textContent).toContain('No activities match your filters')
  expect(host.textContent).not.toContain('Clear filters')
  expect(host.textContent).not.toContain('Dates shown')
  expect(host.textContent).not.toContain('Activity details are coming soon')
  expect(host.textContent).not.toContain('With heart rate')
})

it('clears selected filters as well as their URL', async () => {
  await render()
  await select('activity-sport', 'Walking')
  expect(host.querySelector('#activity-sport')!.textContent).toContain('Walking')
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Reset filters')!
      .click(),
  )
  expect(host.querySelector('#activity-sport')!.textContent).toContain('All sports')
  expect(push).toHaveBeenCalledWith('/app/training', { scroll: false })
})

it('limits both custom calendars to the first activity and today', async () => {
  await render(data, { ...defaults, range: 'custom' })
  for (const id of ['activity-from', 'activity-to']) {
    act(() => host.querySelector<HTMLButtonElement>(`#${id}`)!.click())
    const years = host.querySelector<HTMLSelectElement>('select[aria-label="Year"]')!
    expect([...years.options].map((option) => option.value)).toEqual([
      '2026',
      '2025',
      '2024',
      '2023',
    ])
    expect(
      host.querySelector<HTMLButtonElement>('button[aria-label="November 13, 2026"]')!.disabled,
    ).toBe(true)
    act(() =>
      host
        .querySelector<HTMLElement>(`#${id}-calendar`)!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    )
  }
  act(() => host.querySelector<HTMLButtonElement>('#activity-from')!.click())
  const year = host.querySelector<HTMLSelectElement>('select[aria-label="Year"]')!
  act(() => {
    year.value = '2023'
    year.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(
    host.querySelector<HTMLButtonElement>('button[aria-label="November 10, 2023"]')!.disabled,
  ).toBe(true)
  act(() =>
    host.querySelector<HTMLButtonElement>('button[aria-label="November 11, 2023"]')!.click(),
  )
})

it('keeps custom From/To constraints within the history bounds', async () => {
  await render(data, {
    ...defaults,
    range: 'custom',
    from: '2024-11-20',
    to: '2025-11-19',
  })
  act(() => host.querySelector<HTMLButtonElement>('#activity-from')!.click())
  const year = host.querySelector<HTMLSelectElement>('select[aria-label="Year"]')!
  expect([...year.options].map((option) => option.value)).toEqual(['2025', '2024', '2023'])
  act(() => {
    year.value = '2025'
    year.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(
    host.querySelector<HTMLButtonElement>('button[aria-label="November 20, 2025"]')!.disabled,
  ).toBe(true)
  act(() =>
    host
      .querySelector<HTMLElement>('#activity-from-calendar')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  )
  act(() => host.querySelector<HTMLButtonElement>('#activity-to')!.click())
  expect(
    [...host.querySelector<HTMLSelectElement>('select[aria-label="Year"]')!.options].map(
      (option) => option.value,
    ),
  ).toEqual(['2026', '2025', '2024'])
  expect(
    host.querySelector<HTMLButtonElement>('button[aria-label="November 19, 2025"]')!.disabled,
  ).toBe(false)
})

it('uses distance presets instead of a numeric input and preserves the Ultra selection in the URL', async () => {
  await render()
  expect(host.querySelector('#activity-min-distance')).not.toBeNull()
  expect(host.textContent).not.toContain('More filters')
  await select('activity-sport', 'Running')
  act(() => host.querySelector<HTMLButtonElement>('#activity-min-distance')!.click())
  expect([...host.querySelectorAll('[role="option"]')].map((option) => option.textContent)).toEqual(
    [
      'Any distance',
      '1 km+',
      '3 km+',
      '5 km+',
      '10 km+',
      'Half marathon (21.1 km+)',
      'Marathon (42.195 km+)',
      'Ultra (>42.195 km)',
    ],
  )
  act(() => [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')].at(-1)!.click())
  expect(host.querySelector('input[type="number"]')).toBeNull()
  expect(push).toHaveBeenCalledWith('/app/training?sport=RUNNING&minDistance=ultra', {
    scroll: false,
  })
})

it('updates distance options with the sport and clears an incompatible distance', async () => {
  await render({ ...data, sports: ['RUNNING', 'CYCLING', 'SWIMMING'] })
  await select('activity-sport', 'Running')
  await select('activity-min-distance', 'Half marathon (21.1 km+)')
  await select('activity-sport', 'Cycling')
  expect(host.querySelector('#activity-min-distance')!.textContent).toContain('Any distance')
  act(() => host.querySelector<HTMLButtonElement>('#activity-min-distance')!.click())
  expect(host.querySelector('[role="listbox"]')!.textContent).not.toMatch(/marathon|ultra/i)
  expect(host.querySelector('[role="listbox"]')!.textContent).toContain('100 km+')
  act(() =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    ),
  )
  await select('activity-min-distance', '100 km+')
  expect(push).toHaveBeenCalledWith('/app/training?sport=CYCLING&minDistance=100', {
    scroll: false,
  })
  await select('activity-sport', 'Swimming')
  await select('activity-min-distance', '100 m+')
  expect(host.querySelector('#activity-min-distance')!.textContent).toContain('100 m+')
})

function NavigationGate({ gate }: { gate: Promise<void> | null }) {
  if (gate) use(gate)
  return null
}

it.each([
  { pageSize: 10 as const, target: 'filter', expected: 10 },
  { pageSize: 25 as const, target: 'filter', expected: 25 },
  { pageSize: 50 as const, target: 'filter', expected: 50 },
  { pageSize: 10 as const, target: 'last-page', expected: 2 },
])(
  'shows $expected skeleton rows during a pending $target navigation',
  async ({ pageSize, target, expected }) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    function Scene() {
      const [waiting, setWaiting] = useState<Promise<void> | null>(null)
      push.mockImplementation(() => setWaiting(gate))
      return (
        <MeasurementSystemProvider initialSystem="METRIC">
          <ActivityHistory data={data} query={{ ...defaults, pageSize }} />
          <NavigationGate gate={waiting} />
        </MeasurementSystemProvider>
      )
    }
    await act(async () =>
      root.render(
        <Suspense fallback={<p>Route loading</p>}>
          <Scene />
        </Suspense>,
      ),
    )
    if (target === 'last-page') {
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!.click(),
      )
    } else await select('activity-range', 'Last 7 days')
    expect(host.querySelectorAll('[data-skeleton-row]')).toHaveLength(expected)
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(host.querySelectorAll('tbody tr:not([data-skeleton-row])')).toHaveLength(0)
    await act(async () => release())
    expect(host.querySelectorAll('[data-skeleton-row]')).toHaveLength(0)
  },
)

it('debounces search until typing stops, resets the timer on each edit and returns to page one', async () => {
  vi.useFakeTimers()
  await render({ ...data, page: 2 }, { ...defaults, page: 2 })
  typeSearch('R')
  await act(async () => vi.advanceTimersByTimeAsync(200))
  typeSearch('Run')
  await act(async () => vi.advanceTimersByTimeAsync(699))
  expect(push).not.toHaveBeenCalled()
  await act(async () => vi.advanceTimersByTimeAsync(1))
  expect(push).toHaveBeenCalledExactlyOnceWith('/app/training?q=Run', { scroll: false })
})

it('commits selectors immediately with pending search and cancels delayed navigation on reset', async () => {
  vi.useFakeTimers()
  await render()
  typeSearch('Trail')
  await select('activity-sport', 'Running')
  expect(push).toHaveBeenCalledExactlyOnceWith('/app/training?q=Trail&sport=RUNNING', {
    scroll: false,
  })
  await act(async () => vi.advanceTimersByTimeAsync(1000))
  expect(push).toHaveBeenCalledOnce()
  typeSearch('Outdated')
  act(() =>
    [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Reset filters')!
      .click(),
  )
  await act(async () => vi.advanceTimersByTimeAsync(1000))
  expect(push).toHaveBeenCalledTimes(2)
  expect(push).toHaveBeenLastCalledWith('/app/training', { scroll: false })
  expect(host.querySelector<HTMLInputElement>('#activity-search')!.value).toBe('')
})

it('cancels a pending search on query restoration and unmount', async () => {
  vi.useFakeTimers()
  await render()
  typeSearch('Discarded')
  await render(data, { ...defaults, q: 'Saved' })
  await act(async () => vi.advanceTimersByTimeAsync(1000))
  expect(push).not.toHaveBeenCalled()
  expect(host.querySelector<HTMLInputElement>('#activity-search')!.value).toBe('Saved')
  typeSearch('Leaving')
  await act(async () => root.render(null))
  await act(async () => vi.advanceTimersByTimeAsync(1000))
  expect(push).not.toHaveBeenCalled()
})
