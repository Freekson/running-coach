'use client'
import { useState, type KeyboardEvent } from 'react'
import Link from 'next/link'
import {
  Activity,
  ArrowLeft,
  Bike,
  CalendarDays,
  ExternalLink,
  Flame,
  Footprints,
  Gauge,
  Heart,
  Layers,
  MapPin,
  Mountain,
  RefreshCw,
  Timer,
  Waves,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { SectionHeading } from '@/components/ui/SectionHeading'
import type { ActivityDetail } from '@/lib/activity-detail'
import { activityChartErrors, activityDuration } from '@/lib/activity-detail'
import { activitySportLabel, formatActivityMetrics } from '@/lib/activity-history'
import { useClientReady } from '@/lib/use-client-ready'
import { useMeasurementSystem } from '../../measurement-system-provider'
import { useActivityCharts } from './use-activity-charts'
import { ActivityChartsPanel } from './activity-charts'
import { ActivityRoute } from './activity-route'
import { HeartRateZones } from './heart-rate-zones'
import styles from './activity-detail.module.scss'

const tabs = ['Overview', 'Charts', 'Laps', 'Source'] as const
type Tab = (typeof tabs)[number]
function Metric({ label, value, icon: Icon }: { label: string; value: string; icon: LucideIcon }) {
  return (
    <div className={styles.metric}>
      <Icon size={20} strokeWidth={2} aria-hidden="true" />
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  )
}
export function ActivityDetailView({
  activity,
  backHref = '/app/training',
}: {
  activity: ActivityDetail
  backHref?: string
}) {
  const { system } = useMeasurementSystem()
  const clientReady = useClientReady()
  const [tab, setTab] = useState<Tab>('Overview')
  const fit = useActivityCharts(activity.id)
  const metrics = formatActivityMetrics(activity, system)
  const imperial = system === 'IMPERIAL'
  const height = (value: number | null) =>
    value === null
      ? '—'
      : `${Math.round(value * (imperial ? 3.280839895 : 1))} ${imperial ? 'ft' : 'm'}`
  const sport = activitySportLabel(activity.sport, activity.sourceSport)
  const Icon =
    activity.sport === 'CYCLING'
      ? Bike
      : activity.sport === 'SWIMMING'
        ? Waves
        : activity.sport === 'RUNNING' || activity.sport === 'WALKING'
          ? Footprints
          : Activity
  const canLoad = activity.fitAvailability === 'AVAILABLE'
  const statusMessage = fit.error
    ? (activityChartErrors[fit.error] ?? activityChartErrors.UNAVAILABLE)
    : !canLoad
      ? activityChartErrors[activity.fitAvailability]
      : null
  function changeTab(next: Tab) {
    setTab(next)
    if (next === 'Charts' && canLoad) void fit.load()
  }
  function tabKeys(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.indexOf(tab)
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (index + tabs.length - 1) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : null
    if (next === null) return
    event.preventDefault()
    changeTab(tabs[next])
    document.getElementById(`detail-tab-${tabs[next]}`)?.focus()
  }
  const lapTable = (
    <Card as="section" className={styles.lapsCard} aria-labelledby="laps-heading">
      <SectionHeading id="laps-heading" icon={Layers} title={`Laps (${activity.laps.length})`} />
      {activity.laps.length ? (
        <table className={styles.lapsTable}>
          <caption className={styles.srOnly}>Saved ordered workout laps</caption>
          <thead>
            <tr>
              {[
                'Lap',
                'Distance',
                'Time',
                activity.sport === 'RUNNING' ? 'Pace' : 'Speed',
                'Avg HR',
                'Power',
                'Elevation',
              ].map((label) => (
                <th key={label} scope="col">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {activity.laps.map((lap) => {
              const metric = formatActivityMetrics({ ...activity, ...lap }, system)
              return (
                <tr key={lap.index}>
                  <th scope="row">{lap.index + 1}</th>
                  <td data-label="Distance">{metric.distance}</td>
                  <td data-label="Time">
                    {metric.duration}
                    <small>{metric.durationKind}</small>
                  </td>
                  <td data-label={activity.sport === 'RUNNING' ? 'Pace' : 'Speed'}>
                    {metric.paceOrSpeed}
                  </td>
                  <td data-label="Avg HR">{metric.heartRate}</td>
                  <td data-label="Power">
                    {lap.avgPowerWatts === null ? '—' : `${Math.round(lap.avgPowerWatts)} W`}
                  </td>
                  <td data-label="Elevation">{height(lap.elevationGainMeters)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : (
        <p className={styles.emptyText}>
          {activity.lapImportStatus === 'IMPORTED'
            ? 'This activity contains no laps.'
            : 'No saved laps are available for this activity.'}
        </p>
      )}
    </Card>
  )
  const source = (
    <div className={styles.detailsGrid}>
      <Card as="section" className={styles.infoCard}>
        <SectionHeading icon={Timer} title="Workout details" />
        <dl>
          <div>
            <dt>Start time</dt>
            <dd>
              {clientReady
                ? new Intl.DateTimeFormat('en-US', {
                    dateStyle: 'medium',
                    timeStyle: 'medium',
                  }).format(new Date(activity.startedAt))
                : 'Loading local time…'}
            </dd>
          </div>
          <div>
            <dt>Sport</dt>
            <dd>{sport}</dd>
          </div>
          <div>
            <dt>Timer time</dt>
            <dd>{activityDuration(activity.timerMs)}</dd>
          </div>
          <div>
            <dt>Moving time</dt>
            <dd>{activityDuration(activity.movingMs)}</dd>
          </div>
          <div>
            <dt>Elapsed time</dt>
            <dd>{activityDuration(activity.elapsedMs)}</dd>
          </div>
          <div>
            <dt>Lap count</dt>
            <dd>{activity.laps.length}</dd>
          </div>
        </dl>
      </Card>
      <Card as="section" className={styles.infoCard}>
        <SectionHeading icon={Layers} title="Source details" />
        <dl>
          <div>
            <dt>Activity ID</dt>
            <dd>{activity.externalActivityId ?? '—'}</dd>
          </div>
          {activity.externalActivityUuid && (
            <div>
              <dt>Activity UUID</dt>
              <dd>{activity.externalActivityUuid}</dd>
            </div>
          )}
          {activity.sourceTimezone && (
            <div>
              <dt>Recorded timezone</dt>
              <dd>{activity.sourceTimezone}</dd>
            </div>
          )}
        </dl>
      </Card>
    </div>
  )
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link href={backHref} className={styles.backLink}>
            <ArrowLeft size={16} aria-hidden="true" />
            Training History
          </Link>
          <h1>Activity details</h1>
        </div>
        <div className={styles.headerActions} aria-busy={fit.pending || undefined}>
          {canLoad && (
            <Button
              variant="secondary"
              disabled={fit.pending || fit.coolingDown}
              onClick={() => void fit.load(true)}
            >
              <RefreshCw
                size={18}
                aria-hidden="true"
                className={fit.pending ? styles.spinning : undefined}
              />
              {fit.charts
                ? 'Refresh FIT data'
                : fit.error
                  ? 'Retry FIT download'
                  : 'Load FIT charts'}
            </Button>
          )}
          {activity.provider === 'GARMIN' &&
            /^\d{1,32}$/.test(activity.externalActivityId ?? '') && (
              <a
                className="button button--secondary"
                href={`https://connect.garmin.com/modern/activity/${activity.externalActivityId}`}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
              >
                <ExternalLink size={18} aria-hidden="true" />
                Open in Garmin
              </a>
            )}
        </div>
      </header>
      <Card as="section" className={styles.summaryCard} aria-labelledby="activity-name">
        <div className={styles.workoutHeader}>
          <span className={styles.sportIcon}>
            <Icon size={28} strokeWidth={2} aria-hidden="true" />
          </span>
          <div>
            <h2 id="activity-name">{activity.title || `${sport} activity`}</h2>
            <div className={styles.metadata}>
              <span>
                <CalendarDays size={16} aria-hidden="true" />
                {clientReady
                  ? new Intl.DateTimeFormat('en-US', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(activity.startedAt))
                  : 'Loading local time…'}
              </span>
              <span>{sport}</span>
            </div>
          </div>
        </div>
        <div className={styles.primaryMetrics}>
          <Metric label="Distance" value={metrics.distance} icon={MapPin} />
          <Metric label={metrics.durationKind} value={metrics.duration} icon={Timer} />
          <Metric label="Moving time" value={activityDuration(activity.movingMs)} icon={Timer} />
          <Metric label="Elapsed time" value={activityDuration(activity.elapsedMs)} icon={Timer} />
          <Metric
            label={activity.sport === 'RUNNING' ? 'Avg pace' : 'Avg speed'}
            value={metrics.paceOrSpeed}
            icon={Gauge}
          />
          <Metric label="Avg HR" value={metrics.heartRate} icon={Heart} />
          <Metric
            label="Max HR"
            value={activity.maxHrBpm ? `${activity.maxHrBpm} bpm` : '—'}
            icon={Heart}
          />
          <Metric
            label="Elevation gain"
            value={height(activity.elevationGainMeters)}
            icon={Mountain}
          />
          {activity.cadenceStepsPerMinute !== null && (
            <Metric
              label="Cadence"
              value={`${Math.round(activity.cadenceStepsPerMinute)} spm`}
              icon={Footprints}
            />
          )}
          {activity.calories !== null && (
            <Metric label="Calories" value={`${activity.calories} kcal`} icon={Flame} />
          )}
          {fit.charts?.session.avgPowerWatts != null && (
            <Metric
              label="Avg power"
              value={`${Math.round(fit.charts.session.avgPowerWatts)} W`}
              icon={Zap}
            />
          )}
          {fit.charts?.session.maxPowerWatts != null && (
            <Metric
              label="Max power"
              value={`${Math.round(fit.charts.session.maxPowerWatts)} W`}
              icon={Zap}
            />
          )}
          {fit.charts?.session.aerobicTrainingEffect != null && (
            <Metric
              label="Aerobic training effect"
              value={fit.charts.session.aerobicTrainingEffect.toFixed(1)}
              icon={Activity}
            />
          )}
          {fit.charts?.session.anaerobicTrainingEffect != null && (
            <Metric
              label="Anaerobic training effect"
              value={fit.charts.session.anaerobicTrainingEffect.toFixed(1)}
              icon={Activity}
            />
          )}
          {fit.charts?.session.avgTemperatureCelsius != null && (
            <Metric
              label="Avg temperature"
              value={`${(imperial ? (fit.charts.session.avgTemperatureCelsius * 9) / 5 + 32 : fit.charts.session.avgTemperatureCelsius).toFixed(0)} °${imperial ? 'F' : 'C'}`}
              icon={Gauge}
            />
          )}
        </div>
      </Card>
      <div className={styles.tabs} role="tablist" aria-label="Activity details" onKeyDown={tabKeys}>
        {tabs.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`detail-tab-${name}`}
            aria-selected={tab === name}
            aria-controls="activity-panel"
            tabIndex={tab === name ? 0 : -1}
            onClick={() => changeTab(name)}
          >
            {name}
            {name === 'Laps' ? ` (${activity.laps.length})` : ''}
          </button>
        ))}
      </div>
      <div
        id="activity-panel"
        role="tabpanel"
        aria-labelledby={`detail-tab-${tab}`}
        className={styles.panel}
      >
        {(tab === 'Overview' || tab === 'Charts') && (
          <>
            {statusMessage && (
              <Card className={styles.notice}>
                <p role={fit.error ? 'alert' : 'status'}>{statusMessage}</p>
                {!canLoad && activity.fitAvailability === 'NOT_CONNECTED' && (
                  <ButtonLink href="/app/settings" variant="secondary">
                    Open Settings
                  </ButtonLink>
                )}
                {fit.retryAt && (
                  <p>
                    Retry after{' '}
                    {clientReady
                      ? new Intl.DateTimeFormat('en-US', { timeStyle: 'medium' }).format(
                          new Date(fit.retryAt),
                        )
                      : 'the cooldown'}
                    .
                  </p>
                )}
              </Card>
            )}
            {fit.pending && !fit.charts && (
              <Card
                className={styles.loadingCharts}
                aria-busy="true"
                aria-label="Loading workout charts"
              >
                {[0, 1, 2].map((index) => (
                  <div key={index} className={styles.chartSkeleton} />
                ))}
              </Card>
            )}
            {fit.charts ? (
              <>
                <div className={styles.overviewGrid}>
                  <ActivityRoute samples={fit.charts.samples} />
                  <HeartRateZones seconds={fit.charts.session.heartRateZoneSeconds} />
                </div>
                <ActivityChartsPanel data={fit.charts} sport={activity.sport} />
              </>
            ) : (
              !fit.pending &&
              canLoad && (
                <Card className={styles.chartPrompt}>
                  <LineChartPrompt />
                  <h2>Explore your workout</h2>
                  <p>
                    Load recorded pace, heart rate, power, cadence, elevation and route when
                    available.
                  </p>
                  <Button
                    disabled={fit.coolingDown}
                    onClick={() => {
                      setTab('Charts')
                      void fit.load(true)
                    }}
                  >
                    <Activity size={18} aria-hidden="true" />
                    {fit.error ? 'Retry FIT download' : 'Load detailed charts'}
                  </Button>
                </Card>
              )
            )}
          </>
        )}
        {(tab === 'Overview' || tab === 'Laps') && lapTable}
        {(tab === 'Overview' || tab === 'Source') && source}
      </div>
    </main>
  )
}
function LineChartPrompt() {
  return <Activity size={32} strokeWidth={2} aria-hidden="true" className={styles.promptIcon} />
}
