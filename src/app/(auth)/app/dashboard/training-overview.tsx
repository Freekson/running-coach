'use client'

import { useState, type CSSProperties } from 'react'
import { Activity, Footprints, Layers, Timer, TrendingUp } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { formatActivityMetrics } from '@/lib/activity-history'
import { dashboardDate, type DashboardActivityOverview, type DashboardWeek } from '@/lib/dashboard'
import type { MeasurementSystem } from '@/lib/measurement-system'
import styles from './dashboard.module.scss'

const metricOptions = ['Distance', 'Time', 'Runs'] as const
type Metric = (typeof metricOptions)[number]
function formatted(week: DashboardWeek, system: MeasurementSystem) {
  return formatActivityMetrics(
    {
      sport: 'RUNNING',
      distanceMeters: week.distanceMeters,
      timerMs: week.durationMs,
      movingMs: null,
      elapsedMs: null,
      avgSpeedMps: null,
      avgHrBpm: week.avgHrBpm,
    },
    system,
  )
}
function value(week: DashboardWeek, metric: Metric) {
  return metric === 'Distance'
    ? week.distanceMeters
    : metric === 'Time'
      ? week.durationMs
      : week.sessions
}
function label(week: DashboardWeek, metric: Metric, system: MeasurementSystem) {
  const metricText = formatted(week, system)
  return metric === 'Distance'
    ? metricText.distance
    : metric === 'Time'
      ? metricText.duration
      : String(week.sessions)
}

export function TrainingOverview({
  data,
  system,
}: {
  data: DashboardActivityOverview
  system: MeasurementSystem
}) {
  const [metric, setMetric] = useState<Metric>('Distance')
  const [selected, setSelected] = useState<number | null>(null)
  const current = data.weeks[7]
  const currentMetrics = formatted(current, system)
  const selectedWeek = data.weeks[selected ?? 7]
  const maximum = Math.max(1, ...data.weeks.map((week) => value(week, metric) ?? 0))
  const hasActivities = data.weeks.some((week) => week.sessions > 0)
  const entries = [
    { name: 'Distance', text: currentMetrics.distance, Icon: Footprints },
    { name: 'Duration', text: currentMetrics.duration, Icon: Timer },
    { name: 'Sessions', text: String(current.sessions), Icon: Layers },
    { name: 'Avg HR', text: currentMetrics.heartRate, Icon: Activity },
  ]
  return (
    <>
      <Card as="section" className={styles.summary} aria-labelledby="dashboard-week-heading">
        <div className={styles.period}>
          <h2 id="dashboard-week-heading">This week</h2>
          <p>
            {dashboardDate(current.start)} – {dashboardDate(current.end)}
          </p>
        </div>
        <dl className={styles.metrics}>
          {entries.map(({ name, text, Icon }) => (
            <div key={name}>
              <Icon size={20} strokeWidth={2} aria-hidden="true" />
              <dt>{name}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
        {(current.missingDistance || current.missingDuration) && (
          <p className={styles.summaryNote}>
            Totals include available values; some activities have missing distance or duration.
          </p>
        )}
      </Card>
      <Card
        as="section"
        className={`${styles.card} ${styles.progress}`}
        aria-labelledby="training-progress-heading"
      >
        <div className={styles.cardHeader}>
          <SectionHeading
            id="training-progress-heading"
            icon={TrendingUp}
            title="Training progress"
            subtitle={`Weekly running ${metric === 'Distance' ? 'distance' : metric === 'Time' ? 'time' : 'sessions'}`}
          />
          <div className={styles.switcher} role="group" aria-label="Training progress metric">
            {metricOptions.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={metric === option}
                onClick={() => setMetric(option)}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
        {hasActivities ? (
          <>
            <p className={styles.chartReadout} role="status" aria-live="polite">
              {dashboardDate(selectedWeek.start)} – {dashboardDate(selectedWeek.end)}:{' '}
              <strong>{label(selectedWeek, metric, system)}</strong>
              {selected === null || selected === 7 ? ' · Current week' : ''}
            </p>
            <div
              className={styles.chart}
              role="group"
              aria-label={`Running ${metric.toLowerCase()} for the last eight calendar weeks`}
              onMouseLeave={() => setSelected(null)}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setSelected(null)
              }}
            >
              {data.weeks.map((week, index) => {
                const amount = value(week, metric)
                const description = `${dashboardDate(week.start)} – ${dashboardDate(week.end)}: ${label(week, metric, system)}${index === 7 ? ', current week' : ''}`
                return (
                  <button
                    key={week.start}
                    type="button"
                    className={`${styles.chartColumn} ${index === 7 ? styles.current : ''}`}
                    onFocus={() => setSelected(index)}
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => setSelected(index)}
                    aria-label={description}
                    aria-pressed={selected === index}
                    title={description}
                  >
                    <span className={styles.barArea}>
                      <span
                        className={styles.bar}
                        style={
                          {
                            '--bar-height': `${amount === null ? 0 : (amount / maximum) * 100}%`,
                          } as CSSProperties
                        }
                      />
                    </span>
                    <span className={styles.chartDate}>{dashboardDate(week.start)}</span>
                  </button>
                )
              })}
            </div>
          </>
        ) : (
          <div className={styles.empty}>
            <h3>No runs in the last 8 weeks</h3>
            <p>No saved running activities were found for this period.</p>
          </div>
        )}
      </Card>
    </>
  )
}
