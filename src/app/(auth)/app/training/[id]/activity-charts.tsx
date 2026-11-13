'use client'
import {
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { LineChart } from 'lucide-react'
import type { ActivityCharts } from '@/lib/activity-detail'
import { activityDuration, activitySampleGapSeconds } from '@/lib/activity-detail'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { useMeasurementSystem } from '../../measurement-system-provider'
import { chartMetrics, chartValue, chartValueLabel, smoothValues } from './chart-model'
import styles from './activity-detail.module.scss'

export function ActivityChartsPanel({ data, sport }: { data: ActivityCharts; sport: string }) {
  const { system } = useMeasurementSystem()
  const inspectionId = useId()
  const [requestedAxis, setAxis] = useState('time')
  const [smoothing, setSmoothing] = useState('0')
  const [selection, setSelection] = useState<number | null>(null)
  const running = sport === 'RUNNING'
  const imperial = system === 'IMPERIAL'
  const distanceUnit = imperial ? 1609.344 : 1000
  const hasDistance = useMemo(() => {
    const distances = data.samples.flatMap((sample) =>
      sample.distanceMeters === null ? [] : [sample.distanceMeters],
    )
    return (
      distances.length >= 2 &&
      distances.at(-1)! > 0 &&
      distances.every((distance, index) => index === 0 || distance >= distances[index - 1])
    )
  }, [data.samples])
  const axis = requestedAxis === 'distance' && hasDistance ? 'distance' : 'time'
  const points = useMemo(
    () =>
      data.samples
        .map((sample, index) => ({
          sample,
          index,
          x: axis === 'time' ? sample.timeSeconds : sample.distanceMeters,
        }))
        .filter((point): point is typeof point & { x: number } => point.x !== null),
    [data.samples, axis],
  )
  const maximumX = Math.max(1, ...points.map((point) => point.x))
  const activePosition = useMemo(() => {
    if (selection === null || !points.length) return null
    const selected = data.samples[Math.min(selection, data.samples.length - 1)]
    if (!selected) return null
    return points.reduce(
      (nearest, point, index) =>
        Math.abs(point.sample.timeSeconds - selected.timeSeconds) <
        Math.abs(points[nearest].sample.timeSeconds - selected.timeSeconds)
          ? index
          : nearest,
      0,
    )
  }, [selection, points, data.samples])
  const activePoint = activePosition === null ? null : points[activePosition]
  const activeIndex = activePoint?.index ?? null
  const prepared = useMemo(
    () =>
      chartMetrics.map((metric) => {
        const raw = data.samples.map((sample) => chartValue(sample, metric.key, running, system))
        const values = smoothValues(data.samples, raw, Number(smoothing), metric.key)
        const gap = activitySampleGapSeconds(data.samples)
        let breakCount = 0
        const breaks = data.samples.map((sample, index) => {
          if (values[index] === null || sample.breakBefore?.includes(metric.key)) breakCount++
          return breakCount
        })
        const finite = points
          .map((point) => values[point.index])
          .filter((value): value is number => value !== null)
        const min = finite.length ? Math.min(...finite) : 0,
          max = finite.length ? Math.max(...finite) : 0
        const padding = Math.max(1, (max - min) * 0.12)
        const low = metric.key === 'elevationMeters' ? min - padding : Math.max(0, min - padding),
          high = max + padding
        const y = (value: number) =>
          metric.key === 'speedMps' && running
            ? ((value - low) / (high - low)) * 130 + 15
            : 145 - ((value - low) / (high - low)) * 130
        let path = '',
          connected = false,
          previousTime = -Infinity,
          previousIndex = -1
        for (const point of points) {
          const value = values[point.index]
          if (value === null) {
            connected = false
            continue
          }
          if (
            point.sample.timeSeconds - previousTime > gap ||
            breaks[point.index] > (breaks[previousIndex] ?? 0)
          )
            connected = false
          path += `${connected ? 'L' : 'M'}${(point.x / maximumX) * 1000},${y(value)} `
          connected = true
          previousTime = point.sample.timeSeconds
          previousIndex = point.index
        }
        return { ...metric, values, min: low, max: high, y, path, available: finite.length > 0 }
      }),
    [data.samples, running, system, smoothing, points, maximumX],
  )
  const xLabel = (value: number) =>
    axis === 'time'
      ? activityDuration(value * 1000)
      : `${(value / distanceUnit).toFixed(2)} ${imperial ? 'mi' : 'km'}`
  const activeX = activePoint?.x ?? null
  function pointer(event: PointerEvent<SVGSVGElement>) {
    if (!points.length) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * maximumX
    const nearest = points.reduce((best, point) =>
      Math.abs(point.x - x) < Math.abs(best.x - x) ? point : best,
    )
    setSelection(nearest.index)
  }
  function keyDown(event: KeyboardEvent<SVGSVGElement>) {
    if (!points.length) return
    let next: number
    switch (event.key) {
      case 'ArrowRight':
        next = Math.min(points.length - 1, (activePosition ?? -1) + 1)
        break
      case 'ArrowLeft':
        next = Math.max(0, (activePosition ?? 0) - 1)
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = points.length - 1
        break
      case 'Escape':
        event.preventDefault()
        setSelection(null)
        return
      default:
        return
    }
    event.preventDefault()
    setSelection(points[next].index)
  }
  if (!prepared.some((metric) => metric.available)) return null
  return (
    <Card as="section" className={styles.chartCard} aria-labelledby="charts-title">
      <div className={styles.sectionBar}>
        <SectionHeading id="charts-title" icon={LineChart} title="Workout charts" />
        <div className={styles.chartControls}>
          <div className={styles.segmented} role="group" aria-label="Chart horizontal axis">
            <Button
              size="compact"
              variant="secondary"
              aria-pressed={axis === 'time'}
              onClick={() => setAxis('time')}
            >
              Time
            </Button>
            <Button
              size="compact"
              variant="secondary"
              aria-pressed={axis === 'distance'}
              disabled={!hasDistance}
              onClick={() => setAxis('distance')}
            >
              Distance
            </Button>
          </div>
          <Select
            id="chart-smoothing"
            label="Smoothing"
            value={smoothing}
            onChange={setSmoothing}
            options={[
              { value: '0', label: 'Off' },
              { value: '5', label: '5 s' },
              { value: '15', label: '15 s' },
            ]}
          />
        </div>
      </div>
      <p className={styles.caption}>
        {data.sourceSampleCount.toLocaleString('en-US')} recorded samples
        {data.sampleIntervalSeconds !== null
          ? ` · Typical interval ${data.sampleIntervalSeconds}s`
          : ''}
        {data.samples.length < data.sourceSampleCount
          ? ` · Displaying ${data.samples.length} samples`
          : ''}
      </p>
      <span id={inspectionId} className={styles.srOnly} aria-live="polite">
        {activePoint ? xLabel(activePoint.x) : ''}
      </span>
      <span id={`${inspectionId}-instructions`} className={styles.srOnly}>
        Use Left and Right arrow keys to inspect samples. Home and End jump to the first and last
        sample. Escape clears inspection.
      </span>
      {prepared.map(({ key, label, color, values, min, max, y, path, available }) => {
        if (!available) return null
        const title = key === 'speedMps' ? (running ? 'Pace' : 'Speed') : label
        return (
          <div
            key={key}
            className={styles.chartRow}
            style={{ '--chart-color': color } as CSSProperties}
          >
            <div className={styles.chartLabel}>
              <h3>{title}</h3>
              <strong>
                {activeIndex !== null
                  ? chartValueLabel(values[activeIndex], key, running, imperial, data.cadenceUnit)
                  : '—'}
              </strong>
            </div>
            <div className={styles.chartPlot}>
              <div className={styles.yLabels} aria-hidden="true">
                <span>
                  {chartValueLabel(
                    key === 'speedMps' && running ? min : max,
                    key,
                    running,
                    imperial,
                    data.cadenceUnit,
                  )}
                </span>
                <span>
                  {chartValueLabel(
                    key === 'speedMps' && running ? max : min,
                    key,
                    running,
                    imperial,
                    data.cadenceUnit,
                  )}
                </span>
              </div>
              <div className={styles.chartViewport}>
                <svg
                  viewBox="0 0 1000 160"
                  preserveAspectRatio="none"
                  role="img"
                  tabIndex={0}
                  aria-label={`${title} by ${axis}`}
                  aria-describedby={`${inspectionId}-instructions ${inspectionId}`}
                  onKeyDown={keyDown}
                  onPointerMove={pointer}
                  onPointerDown={pointer}
                  onPointerLeave={(event) => {
                    if (event.pointerType !== 'touch') setSelection(null)
                  }}
                  onBlur={() => setSelection(null)}
                >
                  {[15, 80, 145].map((value) => (
                    <line
                      key={value}
                      x1={0}
                      x2={1000}
                      y1={value}
                      y2={value}
                      className={styles.gridLine}
                    />
                  ))}
                  <path d={path} className={styles.trace} />
                  {activeX !== null && (
                    <line
                      x1={(activeX / maximumX) * 1000}
                      x2={(activeX / maximumX) * 1000}
                      y1={0}
                      y2={160}
                      className={styles.cursor}
                    />
                  )}
                  {activeIndex !== null && activeX !== null && values[activeIndex] !== null && (
                    <circle
                      cx={(activeX / maximumX) * 1000}
                      cy={y(values[activeIndex]!)}
                      r={4}
                      className={styles.chartPoint}
                    />
                  )}
                </svg>
                <div className={styles.xLabels} aria-hidden="true">
                  <span>{xLabel(0)}</span>
                  <span>{xLabel(maximumX / 2)}</span>
                  <span>{xLabel(maximumX)}</span>
                </div>
                {activeX !== null && (
                  <div
                    className={styles.chartTooltip}
                    style={{
                      left: `clamp(50px, ${(activeX / maximumX) * 100}%, calc(100% - 50px))`,
                    }}
                  >
                    <span>{axis === 'time' ? 'Time' : 'Distance'}</span>
                    <strong>{xLabel(activeX)}</strong>
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </Card>
  )
}
