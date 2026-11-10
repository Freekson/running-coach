'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { List, Plus, Scale } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { SectionHeading } from '@/components/ui/SectionHeading'
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
import { useClientReady } from '@/lib/use-client-ready'

function formatDate(date: string) {
  const local = /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00` : date
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(local))
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
  const skipInitialFetch = useRef(true)

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

  const latest = recentWeights[0]
  const trend = useMemo(() => {
    const addedIds = new Set(addedWeights.map((reading) => reading.id))
    const readings = sortWeightReadings([
      ...addedWeights,
      ...chartWeights.filter((reading) => !addedIds.has(reading.id)),
    ])
    return localReady ? createWeightTrend({ readings, period, system }) : null
  }, [chartWeights, addedWeights, period, system, localReady])
  return (
    <Card as="section" className={styles.section} aria-labelledby="weight-heading">
      <div className={styles.sectionHeadingWithAction}>
        <SectionHeading
          icon={Scale}
          id="weight-heading"
          title="Weight history"
          subtitle="Track changes in your weight over time"
        />
        <div className={styles.weightActions}>
          {latest && (
            <div className={styles.periodSwitch} role="group" aria-label="Chart period">
              {chartPeriods.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={period === option}
                  onClick={() => {
                    document.cookie = `${chartPeriodCookie}=${option}; Max-Age=31536000; Path=/app/health; SameSite=Lax`
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
            <SectionHeading icon={List} title="Recent measurements" level={3} />
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
                  {weight.measuredOn || localReady ? formatDate(readingDateKey(weight)) : '\u00a0'}
                </time>
              </li>
            ))}
          </ol>
        </>
      )}
      {notice && (
        <p className={styles.status} role="status" aria-live="polite">
          {notice}
        </p>
      )}
    </Card>
  )
}
