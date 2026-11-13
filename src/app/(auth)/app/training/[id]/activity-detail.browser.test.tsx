// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ActivityDetailView } from './activity-detail'
import { ActivityChartsPanel } from './activity-charts'
import { ActivityRoute } from './activity-route'
import { HeartRateZones } from './heart-rate-zones'
import { MeasurementSystemProvider } from '../../measurement-system-provider'
import { detailFixture, chartsFixture } from './activity-detail.fixtures'
import type { ActivityCharts } from '@/lib/activity-detail'

const mapMock = vi.hoisted(() => ({
  create: vi.fn(),
  setWorkerUrl: vi.fn(),
  events: new Map<string, () => void>(),
  addControl: vi.fn(),
  addSource: vi.fn(),
  addLayer: vi.fn(),
  fitBounds: vi.fn(),
  resize: vi.fn(),
  remove: vi.fn(),
  loaded: vi.fn(() => false),
  observe: vi.fn(),
  disconnect: vi.fn(),
}))
vi.mock('maplibre-gl', () => ({
  setWorkerUrl: mapMock.setWorkerUrl,
  Map: function MockMap(options: unknown) {
    mapMock.create(options)
    return {
      ...mapMock,
      on: (name: string, callback: () => void) => mapMock.events.set(name, callback),
    }
  },
  NavigationControl: class {},
  ScaleControl: class {},
}))

let root: Root
let host: HTMLDivElement
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.clearAllMocks()
  mapMock.events.clear()
  vi.stubEnv('NEXT_PUBLIC_MAPTILER_API_KEY', 'synthetic-public-map-key')
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = mapMock.observe
      disconnect = mapMock.disconnect
    },
  )
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(chartsFixture), {
        headers: { 'Content-Type': 'application/json' },
      }),
  )
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
async function render(activity = detailFixture) {
  await act(async () =>
    root.render(
      <MeasurementSystemProvider initialSystem="METRIC">
        <ActivityDetailView activity={activity} backHref="/app/training?page=2" />
      </MeasurementSystemProvider>,
    ),
  )
}
function button(text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find((entry) =>
    entry.textContent?.includes(text),
  )!
}
function tab(name: string) {
  return host.querySelector<HTMLButtonElement>(`#detail-tab-${name}`)!
}

const partialDistanceCharts: ActivityCharts = {
  ...chartsFixture,
  samples: [null, 0, null, 100, null, 200, null].map((distanceMeters, index) => ({
    ...chartsFixture.samples[0],
    timeSeconds: index * 10,
    distanceMeters,
    heartRateBpm: 140 + index,
  })),
}
async function renderCharts(data = partialDistanceCharts) {
  await act(async () =>
    root.render(
      <MeasurementSystemProvider initialSystem="METRIC">
        <ActivityChartsPanel data={data} sport="RUNNING" />
      </MeasurementSystemProvider>,
    ),
  )
}
function inspectWithKey(key: string) {
  const chart = host.querySelector<SVGSVGElement>('svg[aria-label^="Heart rate by"]')!
  act(() => chart.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
}

it('renders saved summary and ordered laps without any provider requests', async () => {
  await render()
  expect(host.textContent).toContain('Evening Base Run')
  expect(host.textContent).toContain('10.02 km')
  expect(host.querySelector('a')?.getAttribute('href')).toBe('/app/training?page=2')
  expect(host.querySelectorAll('tbody tr')).toHaveLength(5)
  await act(async () => tab('Laps').click())
  await act(async () => tab('Source').click())
  expect(host.textContent).toContain('123456789')
  expect(host.textContent).not.toContain('Source: Garmin')
  expect(host.textContent).not.toContain('Private')
  expect([...host.querySelectorAll('dt')].some((entry) => entry.textContent === 'Source')).toBe(
    false,
  )
  expect(fetchMock).not.toHaveBeenCalled()
})
it('loads charts only on demand, deduplicates requests and reuses data across tabs and controls', async () => {
  let resolve!: (value: Response) => void
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done
      }),
  )
  await render()
  act(() => {
    tab('Charts').click()
    tab('Charts').click()
  })
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(button('Load FIT charts').closest('[aria-busy="true"]')).not.toBeNull()
  expect(button('Load FIT charts').disabled).toBe(true)
  expect(button('Load FIT charts').querySelector('.button__spinner')).toBeNull()
  expect(
    host.querySelector('[aria-label="Loading workout charts"]')?.getAttribute('aria-busy'),
  ).toBe('true')
  expect(host.textContent).not.toContain('Loading recorded FIT charts')
  await act(async () => resolve(new Response(JSON.stringify(chartsFixture))))
  expect(button('Refresh FIT data').closest('[aria-busy="true"]')).toBeNull()
  expect(host.querySelectorAll('svg[aria-label$="by time"]')).toHaveLength(5)
  expect(host.querySelector('[aria-labelledby="activity-name"]')?.textContent).toContain(
    'Avg power263 W',
  )
  await act(async () => tab('Overview').click())
  expect(host.querySelector('[aria-label="Workout route map"]')).not.toBeNull()
  expect(
    host.querySelector('svg[aria-label="FIT recorded time in heart rate zones"]'),
  ).not.toBeNull()
  await act(async () => tab('Charts').click())
  await act(async () => button('Distance').click())
  expect(host.querySelector('svg[aria-label="Heart rate by distance"]')).not.toBeNull()
  expect(fetchMock).toHaveBeenCalledOnce()
  await act(async () => button('Refresh FIT data').click())
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
it('keeps summary/laps available after a rate limit and prevents tab-switch retry loops', async () => {
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        code: 'RATE_LIMITED',
        retryAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      { status: 429, headers: { 'Retry-After': '60' } },
    ),
  )
  await render()
  await act(async () => tab('Charts').click())
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('paused')
  expect(button('Retry FIT download').disabled).toBe(true)
  await act(async () => tab('Laps').click())
  expect(host.querySelectorAll('tbody tr')).toHaveLength(5)
  await act(async () => tab('Charts').click())
  expect(fetchMock).toHaveBeenCalledOnce()
})
it('shows disconnected and unsupported activities without suppressing saved data', async () => {
  await render({ ...detailFixture, fitAvailability: 'NOT_CONNECTED' })
  expect(host.textContent).toContain('Connect Garmin in Settings')
  expect(host.textContent).toContain('Evening Base Run')
  expect(host.querySelectorAll('tbody tr')).toHaveLength(5)
  await act(async () => tab('Charts').click())
  expect(fetchMock).not.toHaveBeenCalled()
})
it('supports keyboard tabs and omits charts for absent measurements', async () => {
  await render()
  await act(async () =>
    tab('Overview').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    ),
  )
  expect(document.activeElement).toBe(tab('Charts'))
  expect(fetchMock).toHaveBeenCalledOnce()
  const data = {
    ...chartsFixture,
    samples: chartsFixture.samples.map((sample) => ({
      ...sample,
      powerWatts: null,
      cadence: null,
      latitude: null,
      longitude: null,
    })),
  }
  await act(async () =>
    root.render(
      <MeasurementSystemProvider initialSystem="IMPERIAL">
        <ActivityChartsPanel data={data} sport="CYCLING" />
      </MeasurementSystemProvider>,
    ),
  )
  expect(host.textContent).not.toContain('No recorded data')
  expect(host.querySelector('svg[aria-label="Power by time"]')).toBeNull()
  expect(host.querySelector('svg[aria-label="Cadence by time"]')).toBeNull()
  expect(host.querySelector('svg[aria-label="Heart rate by time"]')).not.toBeNull()
  await renderCharts({ ...chartsFixture, samples: [] })
  expect(host.querySelector('section')).toBeNull()
  await renderCharts({
    ...chartsFixture,
    samples: chartsFixture.samples.map((sample) => ({
      ...sample,
      speedMps: null,
      heartRateBpm: null,
      powerWatts: null,
      cadence: null,
      elevationMeters: null,
    })),
  })
  expect(host.querySelector('section')).toBeNull()
})
it('renders a local route overlay on a fitted interactive basemap and releases map resources', async () => {
  await act(async () => root.render(<ActivityRoute samples={chartsFixture.samples} />))
  expect(mapMock.create).toHaveBeenCalledWith(
    expect.objectContaining({
      scrollZoom: true,
      style: expect.stringContaining('/streets-v4-dark/style.json?key='),
    }),
  )
  act(() => mapMock.events.get('load')!())
  expect(mapMock.addSource).toHaveBeenCalledWith(
    'workout-route',
    expect.objectContaining({
      type: 'geojson',
      data: expect.objectContaining({
        geometry: expect.objectContaining({ type: 'MultiLineString' }),
      }),
    }),
  )
  expect(mapMock.addLayer).toHaveBeenCalledTimes(2)
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Fit route to map"]')!.click())
  expect(mapMock.fitBounds).toHaveBeenCalledOnce()
  expect(fetchMock).not.toHaveBeenCalled()
  await act(async () => root.render(null))
  expect(mapMock.remove).toHaveBeenCalledOnce()
  expect(mapMock.disconnect).toHaveBeenCalledOnce()
})

it('handles map errors, retries and missing configuration without hiding charts', async () => {
  await act(async () => root.render(<ActivityRoute samples={chartsFixture.samples} />))
  act(() => mapMock.events.get('error')!())
  expect(host.textContent).toContain('The map could not be loaded')
  await act(async () => button('Retry map').click())
  expect(mapMock.create).toHaveBeenCalledTimes(2)
  act(() => mapMock.events.get('load')!())
  expect(host.querySelector('[aria-label="Workout route map"]')?.getAttribute('aria-busy')).toBe(
    'false',
  )
  vi.stubEnv('NEXT_PUBLIC_MAPTILER_API_KEY', '')
  await act(async () => root.render(<ActivityRoute samples={[...chartsFixture.samples]} />))
  expect(host.textContent).toContain('The map service is not configured')
  expect(mapMock.create).toHaveBeenCalledTimes(2)
})

it('keeps a loaded map usable when a tile fails during zoom or pan', async () => {
  await act(async () => root.render(<ActivityRoute samples={chartsFixture.samples} />))
  act(() => mapMock.events.get('load')!())
  // MapLibre returns false again while new tiles are loading after a camera change.
  expect(mapMock.loaded()).toBe(false)
  act(() => mapMock.events.get('error')!())

  expect(host.textContent).not.toContain('The map could not be loaded')
  const fit = host.querySelector<HTMLButtonElement>('[aria-label="Fit route to map"]')!
  expect(fit.disabled).toBe(false)
  act(() => fit.click())
  expect(mapMock.fitBounds).toHaveBeenCalledOnce()
  expect(mapMock.create).toHaveBeenCalledOnce()
})

it('clears an initial map error when the same map finishes loading', async () => {
  await act(async () => root.render(<ActivityRoute samples={chartsFixture.samples} />))
  act(() => mapMock.events.get('error')!())
  expect(host.textContent).toContain('The map could not be loaded')
  act(() => mapMock.events.get('load')!())

  expect(host.textContent).not.toContain('The map could not be loaded')
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Fit route to map"]')!.disabled).toBe(
    false,
  )
  expect(mapMock.create).toHaveBeenCalledOnce()
})

it('enables explicit retry after cooldown and retains loaded charts if a refresh fails', async () => {
  vi.useFakeTimers()
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({ code: 'RATE_LIMITED', retryAt: new Date(Date.now() + 1000).toISOString() }),
      { status: 429 },
    ),
  )
  await render()
  await act(async () => tab('Charts').click())
  expect(button('Retry FIT download').disabled).toBe(true)
  await act(async () => vi.advanceTimersByTimeAsync(1100))
  expect(button('Retry FIT download').disabled).toBe(false)
  await act(async () => button('Retry FIT download').click())
  expect(host.querySelector('svg[aria-label="Heart rate by time"]')).not.toBeNull()
  fetchMock.mockRejectedValueOnce(new Error('Synthetic offline failure'))
  await act(async () => button('Refresh FIT data').click())
  expect(host.querySelector('svg[aria-label="Heart rate by time"]')).not.toBeNull()
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not be reached')
})

it('keeps zone inspection valid when refreshed FIT data contains fewer zones', async () => {
  await act(async () => root.render(<HeartRateZones seconds={[0, 100, 200, 300, 400, 500]} />))
  act(() =>
    host
      .querySelector<SVGPathElement>('path[aria-label^="Zone 5:"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true })),
  )
  expect(host.querySelector('text')?.textContent).toBe('8:20')
  await act(async () => root.render(<HeartRateZones seconds={[0, 10, 20]} />))
  expect(host.querySelector('text')?.textContent).toBe('0:30')
  expect(host.textContent).not.toContain('NaN')
  await act(async () => root.render(<HeartRateZones seconds={[]} />))
  expect(host.textContent).toContain('No heart rate zone durations recorded')
  expect(host.querySelector('svg[aria-label="FIT recorded time in heart rate zones"]')).toBeNull()
})

it('explains named zones on hover, keyboard focus or tap and dismisses the help accessibly', async () => {
  await act(async () => root.render(<HeartRateZones seconds={[10, 100, 200, 300, 400, 500]} />))
  expect(host.textContent).toContain('Below range')
  expect(host.textContent).toContain('Aerobic')
  expect(host.textContent).toContain('Threshold')
  const help = button('')
  expect(help.getAttribute('aria-label')).toBe('About heart rate zones')
  act(() => help.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
  const tooltip = host.querySelector('[role="tooltip"]')!
  expect(help.getAttribute('aria-describedby')).toBe(tooltip.id)
  expect(tooltip.textContent).toContain('anaerobic contribution')
  expect(tooltip.textContent).toContain('Recorded zone boundaries can be customized')
  act(() =>
    help.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: host })),
  )
  expect(host.querySelector('[role="tooltip"]')).toBeNull()
  act(() => help.focus())
  expect(host.querySelector('[role="tooltip"]')).not.toBeNull()
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(host.querySelector('[role="tooltip"]')).toBeNull()
  expect(document.activeElement).toBe(help)
  act(() => help.click())
  expect(help.getAttribute('aria-expanded')).toBe('true')
  act(() => help.click())
  expect(help.getAttribute('aria-expanded')).toBe('false')
  act(() => help.click())
  act(() => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
  expect(host.querySelector('[role="tooltip"]')).toBeNull()
})

it('clears zone hover when leaving a sector or legend row and clears keyboard inspection on blur', async () => {
  await act(async () => root.render(<HeartRateZones seconds={[0, 100, 200, 300, 400, 500]} />))
  const sector = host.querySelector<SVGPathElement>('path[aria-label^="Zone 5:"]')!
  act(() => sector.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
  expect(sector.getAttribute('aria-pressed')).toBe('true')
  act(() =>
    sector.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: host })),
  )
  expect(sector.getAttribute('aria-pressed')).toBe('false')
  expect(host.querySelector('text')?.textContent).toBe('25:00')
  const row = button('Threshold')
  act(() => row.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
  expect(row.getAttribute('aria-pressed')).toBe('true')
  act(() => row.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: host })))
  expect(row.getAttribute('aria-pressed')).toBe('false')
  act(() => row.focus())
  expect(row.getAttribute('aria-pressed')).toBe('true')
  act(() => row.blur())
  expect(row.getAttribute('aria-pressed')).toBe('false')
})

it('restricts distance navigation to known distances while retaining all samples in time mode', async () => {
  await renderCharts()
  expect(host.querySelector('input[type="range"]')).toBeNull()
  expect(host.textContent).not.toContain('Inspect workout')
  inspectWithKey('Home')
  inspectWithKey('ArrowRight')
  inspectWithKey('ArrowRight')
  expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('0:20')
  act(() => button('Distance').click())
  expect(host.textContent).not.toContain('142 bpm')
  inspectWithKey('Home')
  inspectWithKey('ArrowRight')
  expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('0.10 km')
  expect(host.textContent).toContain('143 bpm')
  expect(host.textContent).toContain('Distance0.10 km')
  inspectWithKey('End')
  inspectWithKey('ArrowRight')
  expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('0.20 km')
  expect(host.textContent).toContain('145 bpm')
  act(() => button('Time').click())
  expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('0:50')
})

it('maps pointer inspection to known distances without confusing filtered and original indexes', async () => {
  await renderCharts()
  act(() => button('Distance').click())
  const svg = host.querySelector<SVGSVGElement>('svg[aria-label="Heart rate by distance"]')!
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 150))
  act(() =>
    svg.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 75, bubbles: true })),
  )
  expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('0.10 km')
  expect(host.textContent).toContain('143 bpm')
  act(() => svg.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: host })))
  expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('')
  expect(host.querySelector('[class*="chartTooltip"]')).toBeNull()
})

it('preserves per-metric recording breaks when distance mode omits the marked sample', async () => {
  const data: ActivityCharts = {
    ...chartsFixture,
    samples: chartsFixture.samples.slice(0, 8).map((sample, index) => ({
      ...sample,
      timeSeconds: index * 50,
      distanceMeters: index === 3 ? null : index * 100,
      ...(index === 3 ? { breakBefore: ['heartRateBpm'] } : {}),
    })),
  }
  await act(async () =>
    root.render(
      <MeasurementSystemProvider initialSystem="METRIC">
        <ActivityChartsPanel data={data} sport="RUNNING" />
      </MeasurementSystemProvider>,
    ),
  )
  act(() => button('Distance').click())
  const heartRate = host.querySelector('svg[aria-label="Heart rate by distance"] path')!
  const pace = host.querySelector('svg[aria-label="Pace by distance"] path')!
  expect(heartRate.getAttribute('d')?.match(/M/g)).toHaveLength(2)
  expect(pace.getAttribute('d')?.match(/M/g)).toHaveLength(1)
})

it('preserves unsampled sensor gaps in distance mode without breaking valid zero readings', async () => {
  const data: ActivityCharts = {
    ...chartsFixture,
    samples: chartsFixture.samples.slice(0, 8).map((sample, index) => ({
      ...sample,
      timeSeconds: index * 10,
      distanceMeters: index === 3 ? null : index * 100,
      heartRateBpm: index === 3 ? null : 140 + index,
      powerWatts: index === 3 ? 0 : 200,
    })),
  }
  await renderCharts(data)
  expect(
    host.querySelector('svg[aria-label="Heart rate by time"] path')?.getAttribute('d')?.match(/M/g),
  ).toHaveLength(2)
  act(() => button('Distance').click())
  expect(
    host
      .querySelector('svg[aria-label="Heart rate by distance"] path')
      ?.getAttribute('d')
      ?.match(/M/g),
  ).toHaveLength(2)
  expect(
    host.querySelector('svg[aria-label="Power by distance"] path')?.getAttribute('d')?.match(/M/g),
  ).toHaveLength(1)
  act(() => button('Time').click())
  expect(
    host.querySelector('svg[aria-label="Heart rate by time"] path')?.getAttribute('d')?.match(/M/g),
  ).toHaveLength(2)
})

it.each(['RUNNING', 'CYCLING'])(
  'handles a zero-speed point without distance correctly for %s',
  async (sport) => {
    const data: ActivityCharts = {
      ...chartsFixture,
      samples: chartsFixture.samples.slice(0, 8).map((sample, index) => ({
        ...sample,
        timeSeconds: index * 10,
        distanceMeters: index === 3 ? null : index * 100,
        speedMps: index === 3 ? 0 : 3.5,
      })),
    }
    await act(async () =>
      root.render(
        <MeasurementSystemProvider initialSystem="METRIC">
          <ActivityChartsPanel data={data} sport={sport} />
        </MeasurementSystemProvider>,
      ),
    )
    act(() => button('Distance').click())
    const title = sport === 'RUNNING' ? 'Pace' : 'Speed'
    const path = host.querySelector(`svg[aria-label="${title} by distance"] path`)!
    expect(path.getAttribute('d')?.match(/M/g)).toHaveLength(sport === 'RUNNING' ? 2 : 1)
  },
)

it('selects a valid distance after refresh and falls back to time if distance mode is unavailable', async () => {
  await renderCharts()
  act(() => button('Distance').click())
  inspectWithKey('Home')
  inspectWithKey('ArrowRight')
  await renderCharts({
    ...partialDistanceCharts,
    samples: partialDistanceCharts.samples.map((sample, index) => ({
      ...sample,
      distanceMeters: index === 2 ? 80 : index === 5 ? 200 : null,
    })),
  })
  expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('0.08 km')
  expect(host.textContent).toContain('142 bpm')
  await renderCharts({
    ...partialDistanceCharts,
    samples: partialDistanceCharts.samples.map((sample) => ({ ...sample, distanceMeters: null })),
  })
  expect(button('Distance').disabled).toBe(true)
  expect(host.querySelector('svg[aria-label="Heart rate by time"]')).not.toBeNull()
  expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('0:30')
})
