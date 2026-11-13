import Link from 'next/link'
import { Activity, ArrowRight, CalendarDays, Footprints } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { HealthSnapshot } from '@/components/health/HealthSnapshot'
import type { HealthSnapshotData } from '@/lib/health-snapshot'
import {
  activitySportLabel,
  formatActivityMetrics,
  type ActivityHistoryRow,
} from '@/lib/activity-history'
import { dashboardGreeting, type DashboardActivityOverview } from '@/lib/dashboard'
import type { IncrementalSyncSnapshot } from '@/lib/garmin-incremental-sync'
import type { MeasurementSystem } from '@/lib/measurement-system'
import { TrainingOverview } from './training-overview'
import { GarminSyncPanel } from './garmin-sync-panel'
import styles from './dashboard.module.scss'

export type DashboardContentProps = {
  asOfInstant: string
  timezone: string
  name?: string
  system: MeasurementSystem
  overview: DashboardActivityOverview | null
  recent: ActivityHistoryRow[] | null
  health: HealthSnapshotData | null
  sync: IncrementalSyncSnapshot | null
}

function SectionError({ title }: { title: string }) {
  return (
    <Card className={styles.card}>
      <h2>{title} unavailable</h2>
      <p>Your saved data could not be loaded.</p>
      <Link href="/app/dashboard">Try again</Link>
    </Card>
  )
}

export function DashboardContent({
  asOfInstant,
  timezone,
  name,
  system,
  overview,
  recent,
  health,
  sync,
}: DashboardContentProps) {
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(asOfInstant))
  return (
    <main className={`app-page ${styles.page}`}>
      <header className={styles.header}>
        <time dateTime={asOfInstant}>{date}</time>
        <h1>
          {dashboardGreeting(asOfInstant, timezone, name)} <span aria-hidden="true">👋</span>
        </h1>
        <p>Here&apos;s your training overview.</p>
      </header>
      <div className={styles.overviewGrid}>
        {overview ? (
          <TrainingOverview data={overview} system={system} />
        ) : (
          <div className={styles.overviewError}>
            <SectionError title="Training overview" />
          </div>
        )}
        <Card
          as="section"
          className={`${styles.card} ${styles.next}`}
          aria-labelledby="next-workout-heading"
        >
          <SectionHeading icon={CalendarDays} id="next-workout-heading" title="Next workout" />
          <div className={styles.empty}>
            <CalendarDays size={20} strokeWidth={2} aria-hidden="true" />
            <h3>No workout scheduled yet</h3>
            <p>Create a plan or schedule workouts to see your next session here.</p>
            <small>Workout planning is coming soon.</small>
          </div>
        </Card>
      </div>
      <div className={styles.detailsGrid}>
        {recent ? (
          <Card as="section" className={styles.card} aria-labelledby="recent-activities-heading">
            <div className={styles.cardHeader}>
              <SectionHeading
                icon={Activity}
                id="recent-activities-heading"
                title="Recent activities"
              />
              <Link href="/app/training" className={styles.inlineLink}>
                View all <ArrowRight size={18} strokeWidth={2} aria-hidden="true" />
              </Link>
            </div>
            {recent.length ? (
              <ul className={styles.activities}>
                {recent.map((row) => {
                  const metrics = formatActivityMetrics(row, system)
                  const sport = activitySportLabel(row.sport, row.sourceSport)
                  const Icon = row.sport === 'RUNNING' ? Footprints : Activity
                  return (
                    <li key={row.id}>
                      <Link href={`/app/training/${row.id}`} className={styles.activity}>
                        <span className={styles.activityIcon}>
                          <Icon size={20} strokeWidth={2} aria-hidden="true" />
                        </span>
                        <span className={styles.activityTitle}>
                          <strong>{row.title || `${sport} activity`}</strong>
                          <span>
                            {sport} ·{' '}
                            <time dateTime={row.startedAt}>
                              {new Intl.DateTimeFormat('en-US', {
                                timeZone: timezone,
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric',
                              }).format(new Date(row.startedAt))}
                            </time>
                          </span>
                        </span>
                        <dl className={styles.activityMetrics}>
                          {[
                            { title: 'Distance', value: metrics.distance },
                            { title: 'Duration', value: metrics.duration },
                            {
                              title: row.sport === 'RUNNING' ? 'Pace' : 'Speed',
                              value: metrics.paceOrSpeed,
                            },
                            { title: 'Avg HR', value: metrics.heartRate },
                          ].map((metric) => (
                            <div key={metric.title}>
                              <dt>{metric.title}</dt>
                              <dd>{metric.value}</dd>
                            </div>
                          ))}
                        </dl>
                        <ArrowRight
                          size={18}
                          strokeWidth={2}
                          aria-hidden="true"
                          focusable="false"
                        />
                      </Link>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <div className={styles.empty}>
                <h3>No activities yet</h3>
                <p>Import your Garmin activities in Settings to see your recent sessions.</p>
                <Link href="/app/settings#garmin-data-import-heading">Garmin Data Import</Link>
              </div>
            )}
          </Card>
        ) : (
          <SectionError title="Recent activities" />
        )}
        {health ? (
          <HealthSnapshot data={health} asOfInstant={asOfInstant} variant="compact" />
        ) : (
          <SectionError title="Health snapshot" />
        )}
      </div>
      <GarminSyncPanel initial={sync} asOfInstant={asOfInstant} />
    </main>
  )
}
