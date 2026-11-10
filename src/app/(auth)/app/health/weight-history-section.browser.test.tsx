// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MeasurementSystemProvider } from '../measurement-system-provider'
import { WeightHistorySection } from './weight-history-section'

const requestId = '969e52dd-3b4f-48ce-935a-3ad674584a24'
const initial = {
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
}
let host: HTMLDivElement
let root: Root

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
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root.render(
      <MeasurementSystemProvider initialSystem="METRIC">
        <WeightHistorySection
          initialPeriod="7D"
          initialWeights={initial.weights}
          initialChartWeights={initial.chartWeights}
        />
      </MeasurementSystemProvider>,
    ),
  )
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
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
    'running-coach-weight-chart-period=1Y; Max-Age=31536000; Path=/app/health; SameSite=Lax',
  )
  cookieSetter.mockRestore()
})

it('does not show a full-history action or dialog', () => {
  expect(host.textContent).not.toContain('View all measurements')
  expect(host.querySelectorAll('dialog')).toHaveLength(1)
  expect(host.querySelector('dialog[open]')).toBeNull()
})
