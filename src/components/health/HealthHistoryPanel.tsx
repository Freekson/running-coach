'use client'

import { useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { CalendarDays, ChartNoAxesCombined, HeartPulse, Moon } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { EmptyState } from '@/components/ui/States'
import {
  buildHealthPeriod,
  healthLocalDay,
  type HealthDayPoint,
  type HealthPeriod,
  type HealthTrendRow,
} from '@/lib/health-history'
import { formatLocalDay, formatLocalTime } from '@/lib/local-time'
import { useClientReady } from '@/lib/use-client-ready'
import styles from './health-history-panel.module.scss'

const periods: { value: HealthPeriod; label: string }[] = [
  { value: 7, label: '7D' },
  { value: 30, label: '30D' },
  { value: 90, label: '90D' },
  { value: 365, label: '1Y' },
  { value: 'ALL', label: 'All' },
]

function averagePeriodLabel(period: HealthPeriod): string {
  if (period === 'ALL') return 'All-time average'
  if (period === 365) return '1-year average'
  return `${period}-day average`
}
const subscribe = () => () => {}
const clientTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const serverTimezone = () => 'UTC'
type SleepMode = 'duration' | 'score'
type StageKey = 'light' | 'deep' | 'rem' | 'awake'
type Stages = Record<StageKey, number>
type SleepTooltipPlacement = {
  index: number
  date: string
  left: number
  top: number
  arrowLeft: number
}
const stageOrder: { key: StageKey; label: string }[] = [
  { key: 'light', label: 'Light sleep' },
  { key: 'deep', label: 'Deep sleep' },
  { key: 'rem', label: 'REM sleep' },
  { key: 'awake', label: 'Awake' },
]

function dateLabel(date: string, year = false): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    ...(year ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`))
}

function durationLabel(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 60_000)
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

function stagesFor(point: HealthDayPoint): Stages | null {
  const { sleepLightMs, sleepDeepMs, sleepRemMs, sleepAwakeMs, sleepDurationMs } = point
  const values = [sleepLightMs, sleepDeepMs, sleepRemMs, sleepAwakeMs]
  if (
    sleepDurationMs == null ||
    values.some((value) => value == null || !Number.isFinite(value) || value < 0)
  )
    return null
  const [light, deep, rem, awake] = values as number[]
  const asleep = light + deep + rem
  // Garmin reports awake separately from total sleep. Do not turn any unexplained
  // difference into an invented stage or draw an inconsistent breakdown.
  if (asleep <= 0 || Math.abs(asleep - sleepDurationMs) > 5 * 60_000) return null
  return { light, deep, rem, awake }
}

function weeklyChartPoints(points: HealthDayPoint[]): HealthDayPoint[] {
  const average = (values: (number | null | undefined)[]) => {
    const available = values.filter((value): value is number => value != null)
    return available.length
      ? available.reduce((total, value) => total + value, 0) / available.length
      : null
  }
  const weeks: HealthDayPoint[] = []
  for (let index = 0; index < points.length; index += 7) {
    const days = points.slice(index, index + 7)
    const measuredSleep = days.filter((day) => day.sleepDurationMs != null)
    const completeStages = measuredSleep.map(stagesFor)
    const stagesAvailable =
      measuredSleep.length > 0 && completeStages.every((stages) => stages !== null)
    weeks.push({
      date: days.at(-1)!.date,
      restingHrBpm: average(days.map((day) => day.restingHrBpm)),
      sleepDurationMs: average(days.map((day) => day.sleepDurationMs)),
      sleepScore: average(days.map((day) => day.sleepScore)),
      sleepLightMs: stagesAvailable ? average(completeStages.map((stages) => stages?.light)) : null,
      sleepDeepMs: stagesAvailable ? average(completeStages.map((stages) => stages?.deep)) : null,
      sleepRemMs: stagesAvailable ? average(completeStages.map((stages) => stages?.rem)) : null,
      sleepAwakeMs: stagesAvailable ? average(completeStages.map((stages) => stages?.awake)) : null,
    })
  }
  return weeks
}

function ChartDates({
  start,
  end,
  includeYear = false,
}: {
  start: string
  end: string
  includeYear?: boolean
}) {
  return (
    <div className={styles.chartDates} aria-hidden="true">
      <span>{dateLabel(start, includeYear)}</span>
      <span>{dateLabel(end, includeYear)}</span>
    </div>
  )
}

function PeriodSwitch({
  label,
  selected,
  onSelect,
}: {
  label: string
  selected: HealthPeriod
  onSelect: (period: HealthPeriod) => void
}) {
  return (
    <div className={styles.periodSwitch} role="group" aria-label={label}>
      {periods.map(({ value, label: periodLabel }) => (
        <button
          key={periodLabel}
          type="button"
          aria-pressed={selected === value}
          onClick={() => onSelect(value)}
        >
          {periodLabel}
        </button>
      ))}
    </div>
  )
}

function HeartRateChart({ points, weekly }: { points: HealthDayPoint[]; weekly: boolean }) {
  const values = points.flatMap((point) => (point.restingHrBpm == null ? [] : [point.restingHrBpm]))
  if (!values.length)
    return (
      <EmptyState
        title="No resting heart-rate readings"
        description="Sync Garmin health data to see a trend."
      />
    )
  const minimum = Math.max(0, Math.floor(Math.min(...values) / 10) * 10 - 10)
  const maximum = Math.ceil(Math.max(...values) / 10) * 10 + 10
  const positions = points.map((point, index) =>
    point.restingHrBpm == null
      ? null
      : {
          x: 18 + ((index + 0.5) / points.length) * 940,
          y: 16 + ((maximum - point.restingHrBpm) / (maximum - minimum)) * 168,
        },
  )
  const segments: { x: number; y: number }[][] = []
  positions.forEach((position, index) => {
    if (!position) return
    if (index === 0 || !positions[index - 1]) segments.push([])
    segments.at(-1)?.push(position)
  })
  return (
    <div className={styles.plot}>
      <svg
        viewBox="0 0 1000 200"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Resting heart rate by ${weekly ? 'week' : 'date'}; missing ${weekly ? 'weeks' : 'days'} are gaps`}
      >
        {[16, 100, 184].map((y) => (
          <line key={y} x1="0" x2="1000" y1={y} y2={y} className={styles.gridLine} />
        ))}
        {segments
          .filter((segment) => segment.length > 1)
          .map((segment, index) => (
            <polyline
              key={index}
              points={segment.map(({ x, y }) => `${x},${y}`).join(' ')}
              className={styles.line}
            />
          ))}
      </svg>
      {positions.map((position, index) => {
        if (!position) return null
        const date = dateLabel(points[index].date, true)
        const bpm = Math.round(points[index].restingHrBpm!)
        return (
          <button
            key={points[index].date}
            type="button"
            className={styles.heartPoint}
            style={{ left: `${position.x / 10}%`, top: `${position.y / 2}%` }}
            aria-label={`${weekly ? '7-day average ending ' : ''}${date}: ${bpm} bpm`}
            data-heart-date={points[index].date}
            data-edge={position.x < 250 ? 'first' : position.x > 750 ? 'last' : undefined}
          >
            <span className={styles.heartPointTooltip} aria-hidden="true">
              <strong>{bpm} bpm</strong>
              <span>{weekly ? `7-day average ending ${date}` : date}</span>
            </span>
          </button>
        )
      })}
      <div className={styles.scale} aria-hidden="true">
        <span>{maximum}</span>
        <span>{Math.round((maximum + minimum) / 2)}</span>
        <span>{minimum}</span>
      </div>
    </div>
  )
}

function SleepChart({
  points,
  mode,
  weekly,
}: {
  points: HealthDayPoint[]
  mode: SleepMode
  weekly: boolean
}) {
  const plotRef = useRef<HTMLDivElement>(null)
  const [tooltip, setTooltip] = useState<SleepTooltipPlacement | null>(null)
  const values = points.flatMap((point) => {
    const value = mode === 'duration' ? point.sleepDurationMs : point.sleepScore
    return value == null ? [] : [value]
  })
  if (!values.length)
    return (
      <EmptyState
        title={`No sleep ${mode} readings`}
        description="Sync Garmin health data to see a trend."
      />
    )
  const maximum =
    mode === 'score'
      ? 100
      : Math.max(
          8 * 3_600_000,
          ...points.map((point) => {
            const stages = stagesFor(point)
            return stages
              ? stages.light + stages.deep + stages.rem + stages.awake
              : (point.sleepDurationMs ?? 0)
          }),
        )
  const width = Math.min(24, 700 / points.length)
  const showDurationTooltip = (index: number, height: number) => {
    const plotWidth = plotRef.current?.clientWidth || 1000
    const plotHeight = plotRef.current?.clientHeight || 205
    const anchorX = ((18 + ((index + 0.5) / points.length) * 940) / 1000) * plotWidth
    const tooltipWidth = Math.min(260, plotWidth)
    const left = Math.max(0, Math.min(anchorX - tooltipWidth / 2, plotWidth - tooltipWidth))
    setTooltip({
      index,
      date: points[index].date,
      left,
      top: ((184 - height) / 200) * plotHeight,
      arrowLeft: Math.max(14, Math.min(anchorX - left, tooltipWidth - 14)),
    })
  }
  const hideDurationTooltip = (date: string) => {
    setTooltip((current) => (current?.date === date ? null : current))
  }
  const activePoint =
    tooltip &&
    points[tooltip.index]?.date === tooltip.date &&
    points[tooltip.index].sleepDurationMs != null
      ? points[tooltip.index]
      : null
  const activeStages = activePoint ? stagesFor(activePoint) : null
  return (
    <div className={styles.plot} ref={plotRef}>
      <svg
        viewBox="0 0 1000 200"
        preserveAspectRatio="none"
        role={mode === 'duration' ? 'group' : 'img'}
        aria-label={
          mode === 'duration'
            ? `Sleep duration by ${weekly ? 'week' : 'date'}, with available stage totals stacked light, deep, REM, then awake`
            : `Sleep score by ${weekly ? 'week' : 'date'}`
        }
      >
        {[16, 100, 184].map((y) => (
          <line key={y} x1="0" x2="1000" y1={y} y2={y} className={styles.gridLine} />
        ))}
        {points.map((point, index) => {
          const value = mode === 'duration' ? point.sleepDurationMs : point.sleepScore
          if (value == null) return null
          const x = 18 + ((index + 0.5) / points.length) * 940 - width / 2
          const stages = mode === 'duration' ? stagesFor(point) : null
          const total = stages ? stages.light + stages.deep + stages.rem + stages.awake : value
          const barHeight = Math.max(2, (total / maximum) * 168)
          if (mode === 'duration') {
            let bottom = 184
            const stageRects = stages
              ? stageOrder.map(({ key }) => {
                  const height = (stages[key] / maximum) * 168
                  bottom -= height
                  return height > 0 ? (
                    <rect
                      key={key}
                      data-stage={key}
                      x={x}
                      y={bottom}
                      width={width}
                      height={height}
                      className={styles[key]}
                    />
                  ) : null
                })
              : null
            return (
              <g
                key={point.date}
                data-sleep-date={point.date}
                tabIndex={0}
                role="img"
                aria-label={`${weekly ? '7-day average ending ' : ''}${dateLabel(point.date, true)}: total sleep ${durationLabel(value)}`}
                aria-describedby={
                  tooltip?.date === point.date ? 'sleep-duration-tooltip' : undefined
                }
                onPointerEnter={() => showDurationTooltip(index, barHeight)}
                onPointerLeave={(event) => {
                  if (
                    event.pointerType !== 'touch' &&
                    document.activeElement !== event.currentTarget
                  )
                    hideDurationTooltip(point.date)
                }}
                onClick={() => showDurationTooltip(index, barHeight)}
                onFocus={() => showDurationTooltip(index, barHeight)}
                onBlur={(event) => {
                  if (!event.currentTarget.matches(':hover')) hideDurationTooltip(point.date)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') hideDurationTooltip(point.date)
                }}
              >
                {stageRects ?? (
                  <rect
                    x={x}
                    y={184 - barHeight}
                    width={width}
                    height={barHeight}
                    className={styles.unsegmentedBar}
                  />
                )}
              </g>
            )
          }
          return (
            <rect
              key={point.date}
              x={x}
              y={184 - barHeight}
              width={width}
              height={barHeight}
              className={styles.scoreBar}
              aria-label={`${dateLabel(point.date, true)}: sleep score ${Math.round(value)} out of 100`}
            />
          )
        })}
      </svg>
      {mode === 'duration' && activePoint && tooltip && (
        <div
          id="sleep-duration-tooltip"
          role="tooltip"
          className={styles.sleepTooltip}
          style={
            {
              left: tooltip.left,
              top: tooltip.top,
              '--tooltip-arrow-left': `${tooltip.arrowLeft}px`,
            } as CSSProperties
          }
        >
          <div className={styles.tooltipDate}>
            <CalendarDays size={16} strokeWidth={2} aria-hidden="true" />
            <strong>{`${weekly ? '7-day average ending ' : ''}${dateLabel(activePoint.date, true)}`}</strong>
          </div>
          <div className={styles.tooltipTotal}>
            <span>Total sleep</span>
            <strong>{durationLabel(activePoint.sleepDurationMs!)}</strong>
          </div>
          {activeStages ? (
            <div className={styles.tooltipStages}>
              {stageOrder.map(({ key, label }) => (
                <div key={key}>
                  <span>
                    <i className={styles[key]} aria-hidden="true" />
                    {label}
                  </span>
                  <strong>{durationLabel(activeStages[key])}</strong>
                </div>
              ))}
            </div>
          ) : (
            <p className={styles.tooltipUnavailable}>Stage breakdown unavailable</p>
          )}
          {activePoint.sleepScore != null && (
            <div className={styles.tooltipScore}>
              <ChartNoAxesCombined size={16} strokeWidth={2} aria-hidden="true" />
              <span>Sleep score</span>
              <strong>{Math.round(activePoint.sleepScore)}</strong>
            </div>
          )}
        </div>
      )}
      <div className={styles.scale} aria-hidden="true">
        <span>{mode === 'score' ? '100' : `${Math.ceil(maximum / 3_600_000)}h`}</span>
        <span>{mode === 'score' ? '50' : `${Math.round(maximum / 7_200_000)}h`}</span>
        <span>0</span>
      </div>
    </div>
  )
}

function LastNight({ point, localReady }: { point: HealthDayPoint | null; localReady: boolean }) {
  if (!point || point.sleepDurationMs == null)
    return (
      <Card as="section" className={styles.nightCard} aria-labelledby="last-night-heading">
        <SectionHeading icon={Moon} id="last-night-heading" title="Last night's sleep" />
        <EmptyState
          title="No sleep reading yet"
          description="Sync Garmin health data to see your latest night."
        />
      </Card>
    )
  const stages = stagesFor(point)
  const totalStages = stages ? stages.light + stages.deep + stages.rem + stages.awake : 0
  const start = localReady && point.sleepStartedAt ? formatLocalTime(point.sleepStartedAt) : null
  const end = localReady && point.sleepEndedAt ? formatLocalTime(point.sleepEndedAt) : null
  return (
    <Card as="section" className={styles.nightCard} aria-labelledby="last-night-heading">
      <SectionHeading icon={Moon} id="last-night-heading" title="Last night's sleep" />
      <div className={styles.nightSummary}>
        <div>
          <strong>{durationLabel(point.sleepDurationMs)}</strong>
          <span>Total sleep · {dateLabel(point.date, true)}</span>
        </div>
        <div
          className={styles.scoreRing}
          aria-label={
            point.sleepScore == null
              ? 'Sleep score unavailable'
              : `Sleep score ${point.sleepScore} out of 100`
          }
        >
          <svg viewBox="0 0 100 100" aria-hidden="true">
            <circle cx="50" cy="50" r="42" className={styles.scoreTrack} />
            {point.sleepScore != null && (
              <circle
                cx="50"
                cy="50"
                r="42"
                className={styles.scoreProgress}
                strokeDasharray={`${(point.sleepScore / 100) * 264} 264`}
              />
            )}
          </svg>
          <span>{point.sleepScore == null ? '—' : point.sleepScore}</span>
          <small>{point.sleepScore == null ? 'No score' : '/ 100'}</small>
        </div>
      </div>
      {start && end && (
        <div className={styles.nightTimes}>
          <div>
            <span>Sleep start</span>
            <strong>{start}</strong>
            <span>{formatLocalDay(point.sleepStartedAt!)}</span>
          </div>
          <div>
            <span>Sleep end</span>
            <strong>{end}</strong>
            <span>{formatLocalDay(point.sleepEndedAt!)}</span>
          </div>
        </div>
      )}
      <div className={styles.stageHeading}>
        <h4>Sleep stages</h4>
        {stages && <span>{durationLabel(totalStages)} including awake</span>}
      </div>
      {stages ? (
        <>
          <div
            className={styles.stageStrip}
            role="img"
            aria-label="Sleep stage totals: light, deep, REM, awake"
          >
            {stageOrder.map(
              ({ key }) =>
                stages[key] > 0 && (
                  <span key={key} className={styles[key]} style={{ flexGrow: stages[key] }} />
                ),
            )}
          </div>
          <div className={styles.stageTiles}>
            {stageOrder.map(({ key, label }) => (
              <div key={key}>
                <span className={styles.stageLabel}>
                  <i className={styles[key]} aria-hidden="true" />
                  {label}
                </span>
                <strong>{durationLabel(stages[key])}</strong>
                {key !== 'awake' && (
                  <small>{Math.round((stages[key] / point.sleepDurationMs!) * 100)}%</small>
                )}
              </div>
            ))}
          </div>
          <p className={styles.note}>
            Stage percentages use total sleep. Awake time is shown separately.
          </p>
        </>
      ) : (
        <p className={styles.note}>Stage breakdown is unavailable for this night.</p>
      )}
    </Card>
  )
}

export function HealthHistoryPanel({
  rows,
  asOfInstant,
  preferredTimezone,
}: {
  rows: HealthTrendRow[]
  asOfInstant: string
  preferredTimezone: string | null
}) {
  const [heartPeriod, setHeartPeriod] = useState<HealthPeriod>(30)
  const [sleepPeriod, setSleepPeriod] = useState<HealthPeriod>(30)
  const [sleepMode, setSleepMode] = useState<SleepMode>('duration')
  const clientReady = useClientReady()
  const browserTimezone = useSyncExternalStore(subscribe, clientTimezone, serverTimezone)
  const today = healthLocalDay(asOfInstant, preferredTimezone ?? browserTimezone)
  const heartTrend = useMemo(
    () => buildHealthPeriod(rows, heartPeriod, today),
    [rows, heartPeriod, today],
  )
  const sleepTrend = useMemo(
    () => buildHealthPeriod(rows, sleepPeriod, today),
    [rows, sleepPeriod, today],
  )
  const heartWeekly = heartPeriod === 365 || heartPeriod === 'ALL'
  const sleepWeekly = sleepPeriod === 365 || sleepPeriod === 'ALL'
  const heartChartPoints = useMemo(
    () => (heartWeekly ? weeklyChartPoints(heartTrend.points) : heartTrend.points),
    [heartTrend, heartWeekly],
  )
  const sleepChartPoints = useMemo(
    () => (sleepWeekly ? weeklyChartPoints(sleepTrend.points) : sleepTrend.points),
    [sleepTrend, sleepWeekly],
  )
  const latestHr = [...rows].reverse().find((row) => row.restingHrBpm != null)
  const latestSleep = [...rows].reverse().find((row) => row.sleepDurationMs != null) ?? null
  const latestPoint = latestSleep
    ? (sleepTrend.points.find((point) => point.date === latestSleep.date) ??
      rows.find((row) => row.date === latestSleep.date) ??
      null)
    : null
  const scoreAverage = sleepTrend.sleepScoreAverage
  const sleepAverage = sleepTrend.sleepAverage
  return (
    <div className={styles.history}>
      <Card as="section" className={styles.trendCard} aria-labelledby="sleep-history-heading">
        <div className={styles.heartHeader}>
          <SectionHeading icon={Moon} id="sleep-history-heading" title="Sleep trends" />
        </div>
        <div className={styles.trendOverview}>
          <div className={styles.trendSummary}>
            <strong>
              {sleepMode === 'duration'
                ? sleepAverage.value == null
                  ? '—'
                  : durationLabel(sleepAverage.value)
                : scoreAverage.value == null
                  ? '—'
                  : `${Math.round(scoreAverage.value)} / 100`}
            </strong>
            <span>
              {averagePeriodLabel(sleepPeriod)}{' '}
              {sleepMode === 'duration' ? 'duration' : 'sleep score'}
            </span>
          </div>
          <div className={styles.sleepControls}>
            <PeriodSwitch label="Sleep period" selected={sleepPeriod} onSelect={setSleepPeriod} />
            <div className={styles.modeSwitch} role="group" aria-label="Sleep trend metric">
              <button
                type="button"
                aria-pressed={sleepMode === 'duration'}
                onClick={() => setSleepMode('duration')}
              >
                Duration
              </button>
              <button
                type="button"
                aria-pressed={sleepMode === 'score'}
                onClick={() => setSleepMode('score')}
              >
                Score
              </button>
            </div>
          </div>
        </div>
        <SleepChart
          key={`${sleepMode}-${sleepPeriod}`}
          points={sleepChartPoints}
          mode={sleepMode}
          weekly={sleepWeekly}
        />
        <ChartDates
          start={sleepTrend.startDate}
          end={sleepTrend.endDate}
          includeYear={sleepPeriod === 365 || sleepPeriod === 'ALL'}
        />
        {sleepMode === 'duration' && (
          <div className={styles.stageLegend} aria-label="Sleep stage colors">
            {stageOrder.map(({ key, label }) => (
              <span key={key}>
                <i className={styles[key]} aria-hidden="true" />
                {label}
              </span>
            ))}
          </div>
        )}
      </Card>
      <div className={styles.summaryCards}>
        <Card
          as="section"
          className={styles.heartCard}
          aria-labelledby="heart-rate-history-heading"
        >
          <div className={styles.heartHeader}>
            <SectionHeading
              icon={HeartPulse}
              id="heart-rate-history-heading"
              title="Resting heart rate"
              subtitle="Daily Garmin measurements"
            />
            <PeriodSwitch
              label="Heart rate period"
              selected={heartPeriod}
              onSelect={setHeartPeriod}
            />
          </div>
          <div className={styles.heartMetrics}>
            <div>
              <strong>{latestHr?.restingHrBpm ?? '—'}</strong>
              <span>bpm</span>
            </div>
            <div>
              <span>{averagePeriodLabel(heartPeriod)}</span>
              <strong>
                {heartTrend.restingHrAverage.value == null
                  ? '—'
                  : `${Math.round(heartTrend.restingHrAverage.value)} bpm`}
              </strong>
            </div>
          </div>
          <HeartRateChart points={heartChartPoints} weekly={heartWeekly} />
          <ChartDates
            start={heartTrend.startDate}
            end={heartTrend.endDate}
            includeYear={heartPeriod === 365 || heartPeriod === 'ALL'}
          />
        </Card>
        <LastNight point={latestPoint} localReady={clientReady} />
      </div>
    </div>
  )
}
