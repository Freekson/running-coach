'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Plus, Scale } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Dialog } from '@/components/ui/Dialog'
import {
  formatWeight,
  formatWeightDifference,
  type MeasurementSystem,
} from '@/lib/measurement-system'
import {
  buildWeightChart,
  chartPeriodCookie,
  chartPeriods,
  readingDateKey,
  sortWeightReadings,
  type ChartPeriod,
  type WeightReading,
} from './weight-history'
import styles from './athlete-settings.module.scss'
import { useClientReady } from './use-client-ready'

type HistoryPage = {
  items: WeightReading[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

function formatDate(date: string) {
  const local = /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00` : date
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(local))
}

function formatAddedTime(date: string) {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(date))
}

function dayNumber(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  return Date.UTC(year, month - 1, day) / 86_400_000
}

function ChartPlaceholder({
  children,
  statusLabel,
}: {
  children: ReactNode
  statusLabel?: string
}) {
  return (
    <div
      className={`${styles.trend} ${styles.chartPlaceholder}`}
      role={statusLabel ? 'status' : undefined}
      aria-label={statusLabel}
    >
      <div className={styles.trendBody}>
        <div aria-hidden="true" />
        <div className={styles.trendPlot}>{children}</div>
      </div>
      <div className={styles.trendDates} aria-hidden="true">
        <span>&nbsp;</span>
      </div>
    </div>
  )
}

function createWeightTrend({
  readings,
  period,
  system,
}: {
  readings: WeightReading[]
  period: ChartPeriod
  system: MeasurementSystem
}) {
  const { points, weekly, startDate, endDate, changeKg } = buildWeightChart(
    readings,
    period,
    new Date(),
  )
  if (!points.length) {
    return {
      chart: (
        <ChartPlaceholder>
          <p className={styles.chartEmpty}>No measurements in this period.</p>
        </ChartPlaceholder>
      ),
      changeKg,
    }
  }
  const values = points.map((point) => point.valueKg)
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  const padding = Math.max((maximum - minimum) * 0.12, 0.25)
  const low = Math.max(0, minimum - padding)
  const high = maximum + padding
  const firstDay = dayNumber(startDate)
  const span = Math.max(dayNumber(endDate) - firstDay, 1)
  const positions = points.map((point) => ({
    ...point,
    x: points.length === 1 ? 500 : 8 + ((dayNumber(point.date) - firstDay) / span) * 984,
    y: 20 + ((high - point.valueKg) / (high - low)) * 190,
  }))
  const line = positions.map((point) => `${point.x},${point.y}`).join(' ')
  const area = `${positions[0].x},220 ${line} ${positions.at(-1)!.x},220`
  const axisValue = (valueKg: number) =>
    (system === 'IMPERIAL' ? valueKg / 0.45359237 : valueKg).toFixed(1)

  return {
    changeKg,
    chart: (
      <div className={styles.trend}>
        <div className={styles.trendBody}>
          <div className={styles.trendAxis} aria-hidden="true">
            <span>{axisValue(high)}</span>
            <span>{axisValue((high + low) / 2)}</span>
            <span>{axisValue(low)}</span>
          </div>
          <div className={styles.trendPlot}>
            <svg viewBox="0 0 1000 240" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <linearGradient id="weight-trend-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.19" />
                  <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0" />
                </linearGradient>
              </defs>
              {[20, 115, 210].map((y) => (
                <line key={y} x1="0" x2="1000" y1={y} y2={y} className={styles.gridLine} />
              ))}
              {positions.length > 1 && (
                <>
                  <polygon points={area} fill="url(#weight-trend-fill)" />
                  <polyline points={line} className={styles.trendLine} />
                </>
              )}
            </svg>
            {positions.map((point) => {
              const tooltip = point.averageStart
                ? `${formatWeight(point.valueKg, system)} weekly average, ${formatDate(point.averageStart)} to ${formatDate(point.averageEnd!)}`
                : `${formatWeight(point.valueKg, system)} on ${formatDate(point.date)}`
              return (
                <button
                  key={point.id}
                  type="button"
                  className={styles.trendPoint}
                  style={{ left: `${(point.x / 1000) * 100}%`, top: `${(point.y / 240) * 100}%` }}
                  aria-label={tooltip}
                  data-edge={point.x < 250 ? 'first' : point.x > 750 ? 'last' : undefined}
                >
                  <span className={styles.pointTooltip}>
                    <strong>{formatWeight(point.valueKg, system)}</strong>
                    <span>{point.averageStart ? 'Weekly average' : formatDate(point.date)}</span>
                    {point.averageStart && (
                      <span>
                        {formatDate(point.averageStart)} – {formatDate(point.averageEnd!)}
                      </span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
        <div className={styles.trendDates}>
          <span>{formatDate(startDate)}</span>
          {weekly && <span>Weekly averages</span>}
          <span>{formatDate(endDate)}</span>
        </div>
      </div>
    ),
  }
}

export function WeightHistoryPanel({
  initialPeriod,
  recentWeights,
  addedWeights,
  initialChartWeights,
  system,
  onAdd,
  notice,
}: {
  initialPeriod: ChartPeriod
  recentWeights: WeightReading[]
  addedWeights: WeightReading[]
  initialChartWeights: WeightReading[]
  system: MeasurementSystem
  onAdd: () => void
  notice: string
}) {
  const [period, setPeriod] = useState<ChartPeriod>(initialPeriod)
  const localReady = useClientReady()
  const [chartWeights, setChartWeights] = useState(initialChartWeights)
  const [chartPending, setChartPending] = useState(false)
  const [chartError, setChartError] = useState('')
  const [chartRetry, setChartRetry] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyPage, setHistoryPage] = useState(1)
  const [history, setHistory] = useState<HistoryPage | null>(null)
  const [historyPending, setHistoryPending] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [historyRetry, setHistoryRetry] = useState(0)
  const skipInitialFetch = useRef(true)
  const historyBody = useRef<HTMLDivElement>(null)
  const historyPageLabel = useRef<HTMLSpanElement>(null)
  const focusPageAfterLoad = useRef(false)

  useEffect(() => {
    if (skipInitialFetch.current) {
      skipInitialFetch.current = false
      return
    }
    const controller = new AbortController()
    async function load() {
      setChartPending(true)
      setChartError('')
      try {
        const response = await fetch(`/api/athlete/weight?view=chart&period=${period}`, {
          signal: controller.signal,
        })
        if (!response.ok) throw new Error('Loading failed')
        const data: { items: WeightReading[] } = await response.json()
        setChartWeights(data.items)
      } catch {
        if (!controller.signal.aborted) setChartError('Could not load the chart. Try again.')
      } finally {
        if (!controller.signal.aborted) setChartPending(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [period, chartRetry])

  useEffect(() => {
    if (!historyOpen) return
    const controller = new AbortController()
    async function load() {
      setHistoryPending(true)
      setHistoryError('')
      try {
        const response = await fetch(`/api/athlete/weight?view=history&page=${historyPage}`, {
          signal: controller.signal,
        })
        if (!response.ok) throw new Error('Loading failed')
        setHistory((await response.json()) as HistoryPage)
      } catch {
        if (!controller.signal.aborted) setHistoryError('Could not load measurements. Try again.')
      } finally {
        if (!controller.signal.aborted) setHistoryPending(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [historyOpen, historyPage, historyRetry])

  useEffect(() => {
    if (historyPending || !history || !focusPageAfterLoad.current) return
    focusPageAfterLoad.current = false
    if (!historyError) historyPageLabel.current?.focus()
  }, [historyPending, history, historyError])

  function changeHistoryPage(delta: number) {
    historyBody.current?.focus()
    focusPageAfterLoad.current = true
    setHistoryPage((page) => page + delta)
  }

  const latest = recentWeights[0]
  const trend = useMemo(() => {
    const addedIds = new Set(addedWeights.map((reading) => reading.id))
    const readings = sortWeightReadings([
      ...addedWeights,
      ...chartWeights.filter((reading) => !addedIds.has(reading.id)),
    ])
    return localReady ? createWeightTrend({ readings, period, system }) : null
  }, [chartWeights, addedWeights, period, system, localReady])
  const historyGroups = useMemo(() => {
    const groups = new Map<string, WeightReading[]>()
    for (const weight of history?.items ?? []) {
      const date = readingDateKey(weight)
      const group = groups.get(date) ?? []
      group.push(weight)
      groups.set(date, group)
    }
    return [...groups.entries()]
  }, [history])

  return (
    <>
      <Card as="section" className={styles.section} aria-labelledby="weight-heading">
        <div className={styles.sectionHeadingWithAction}>
          <div className={styles.sectionHeading}>
            <span className={styles.sectionIcon}>
              <Scale size={20} strokeWidth={2} aria-hidden="true" />
            </span>
            <div>
              <h2 id="weight-heading">Weight history</h2>
              <p>Track changes in your weight over time</p>
            </div>
          </div>
          <div className={styles.weightActions}>
            {latest && (
              <div className={styles.periodSwitch} role="group" aria-label="Chart period">
                {chartPeriods.map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={period === option}
                    onClick={() => {
                      document.cookie = `${chartPeriodCookie}=${option}; Max-Age=31536000; Path=/app/settings; SameSite=Lax`
                      setPeriod(option)
                    }}
                  >
                    {option === 'ALL' ? 'All' : option}
                  </button>
                ))}
              </div>
            )}
            <Button onClick={onAdd}>
              <Plus size={18} strokeWidth={2} aria-hidden="true" />
              Add weight
            </Button>
          </div>
        </div>
        {!latest ? (
          <div className={styles.emptyHistory}>
            No weight readings yet. Add your first measurement to see your trend.
          </div>
        ) : (
          <>
            <div className={styles.chartCard}>
              <div className={styles.chartSummary}>
                <div>
                  <strong className={styles.latestWeight}>
                    {formatWeight(latest.valueKg, system)}
                  </strong>
                  <p>Latest recorded weight</p>
                </div>
                {!chartPending && !chartError && trend && trend.changeKg !== null && (
                  <div className={styles.periodChange}>
                    <strong>{formatWeightDifference(trend.changeKg, system)}</strong>
                    <span>Over the selected period</span>
                  </div>
                )}
              </div>
              {chartPending || !trend ? (
                <ChartPlaceholder statusLabel="Loading chart">
                  <span className={styles.chartSpinner} aria-hidden="true" />
                </ChartPlaceholder>
              ) : chartError ? (
                <ChartPlaceholder>
                  <div className={styles.loadError} role="alert">
                    <p>{chartError}</p>
                    <Button variant="secondary" onClick={() => setChartRetry((retry) => retry + 1)}>
                      Retry
                    </Button>
                  </div>
                </ChartPlaceholder>
              ) : (
                trend.chart
              )}
            </div>
            <div className={styles.recentHeading}>
              <h3>Recent measurements</h3>
              <span>
                Latest {recentWeights.length} {recentWeights.length === 1 ? 'record' : 'records'}
              </span>
            </div>
            <ol className={styles.recentCards}>
              {recentWeights.slice(0, 3).map((weight, index) => (
                <li key={weight.id}>
                  <span>{index === 0 ? 'Latest reading' : 'Previous reading'}</span>
                  <strong>{formatWeight(weight.valueKg, system)}</strong>
                  <time dateTime={weight.measuredOn ?? weight.measuredAt}>
                    {weight.measuredOn || localReady
                      ? formatDate(readingDateKey(weight))
                      : '\u00a0'}
                  </time>
                </li>
              ))}
            </ol>
            <Button
              variant="secondary"
              className={styles.viewAll}
              onClick={() => {
                setHistoryPage(1)
                setHistory(null)
                setHistoryOpen(true)
              }}
            >
              View all measurements
            </Button>
          </>
        )}
        {notice && (
          <p className={styles.status} role="status" aria-live="polite">
            {notice}
          </p>
        )}
      </Card>
      <Dialog
        open={historyOpen}
        title="Weight history"
        description={
          history
            ? `${history.total} ${history.total === 1 ? 'measurement' : 'measurements'} recorded`
            : undefined
        }
        className={styles.historyDialog}
        onClose={() => setHistoryOpen(false)}
      >
        <div
          ref={historyBody}
          className={styles.fullHistory}
          tabIndex={-1}
          aria-busy={historyPending}
        >
          {historyPending && (
            <div className={styles.historyLoading} role="status" aria-label="Loading measurements">
              <span className={styles.chartSpinner} aria-hidden="true" />
            </div>
          )}
          {historyError && (
            <div className={styles.loadError} role="alert">
              <p>{historyError}</p>
              <Button variant="secondary" onClick={() => setHistoryRetry((retry) => retry + 1)}>
                Retry
              </Button>
            </div>
          )}
          {!historyError && history && (
            <div
              className={`${styles.historyResults} ${historyPending ? styles.historyResultsPending : ''}`}
              aria-hidden={historyPending}
            >
              {history.items.length === 0 && <p>No measurements on this page.</p>}
              {historyGroups.map(([date, readings], groupIndex) => (
                <section
                  key={date}
                  className={styles.historyGroup}
                  aria-labelledby={`weight-${date}`}
                >
                  <div className={styles.historyDateHeading}>
                    <h3 id={`weight-${date}`}>{formatDate(date)}</h3>
                    <span>
                      {readings.length} {readings.length === 1 ? 'reading' : 'readings'}
                    </span>
                  </div>
                  {groupIndex === 0 && (
                    <div className={styles.historyColumns} aria-hidden="true">
                      <span>Added at</span>
                      <span>Weight</span>
                    </div>
                  )}
                  <ol>
                    {readings.map((weight) => (
                      <li key={weight.id}>
                        <div className={styles.historyAddedAt}>
                          <time
                            dateTime={weight.createdAt}
                            aria-label={`Added ${formatDate(weight.createdAt)} at ${formatAddedTime(weight.createdAt)}`}
                            title={`Added ${formatDate(weight.createdAt)}`}
                          >
                            {formatAddedTime(weight.createdAt)}
                          </time>
                          {history.page === 1 && history.items[0]?.id === weight.id && (
                            <span className={styles.latestBadge}>Latest</span>
                          )}
                        </div>
                        <strong>{formatWeight(weight.valueKg, system)}</strong>
                      </li>
                    ))}
                  </ol>
                </section>
              ))}
              <div className={styles.historyPagination}>
                <span>
                  {history.total === 0 ? 0 : (history.page - 1) * history.pageSize + 1}–
                  {(history.page - 1) * history.pageSize + history.items.length} of {history.total}
                </span>
                <div className={styles.historyPageControls}>
                  <Button
                    variant="secondary"
                    size="compact"
                    className={styles.historyPageButton}
                    aria-label="Previous page"
                    disabled={historyPage <= 1}
                    onClick={() => changeHistoryPage(-1)}
                  >
                    <ChevronLeft size={18} strokeWidth={2} aria-hidden="true" />
                  </Button>
                  <span
                    ref={historyPageLabel}
                    tabIndex={-1}
                    aria-live="polite"
                    aria-label={`Page ${history.page} of ${history.totalPages}`}
                  >
                    {history.page} / {history.totalPages}
                  </span>
                  <Button
                    variant="secondary"
                    size="compact"
                    className={styles.historyPageButton}
                    aria-label="Next page"
                    disabled={historyPage >= history.totalPages}
                    onClick={() => changeHistoryPage(1)}
                  >
                    <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </Dialog>
    </>
  )
}
