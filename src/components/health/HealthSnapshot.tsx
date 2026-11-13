'use client'

import {
  ArrowRight,
  BedDouble,
  Heart,
  HeartPulse,
  Info,
  MoonStar,
  type LucideIcon,
} from 'lucide-react'
import Link from 'next/link'
import { Card } from '@/components/ui/Card'
import { SectionHeading } from '@/components/ui/SectionHeading'
import type { HealthReading, HealthSnapshotData } from '@/lib/health-snapshot'
import { formatLocalDateTime } from '@/lib/local-time'
import { useClientReady } from '@/lib/use-client-ready'
import styles from './health-snapshot.module.scss'

function localDay(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant))
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

function Measurement({
  label,
  reading,
  unit,
  format,
  asOfInstant,
  checked,
  failedDate,
  compact = false,
  icon: Icon,
}: {
  label: string
  reading: HealthReading | null
  unit: string
  format: (value: number) => string
  asOfInstant: string
  checked: boolean
  failedDate?: string | null
  compact?: boolean
  icon?: LucideIcon
}) {
  const stale = reading
    ? Date.parse(`${localDay(asOfInstant, reading.timezone)}T12:00:00Z`) -
        Date.parse(`${reading.date}T12:00:00Z`) >
      7 * 86_400_000
    : false
  return (
    <div className={styles.measurement}>
      <dt>
        {Icon && <Icon size={20} strokeWidth={2} aria-hidden="true" focusable="false" />}
        {label}
      </dt>
      <dd>
        {reading
          ? `${format(reading.value)}${unit ? ` ${unit}` : ''}`
          : failedDate
            ? 'Request failed'
            : checked
              ? 'No data'
              : 'Not checked yet'}
      </dd>
      {!compact && (
        <p>
          {reading
            ? `${reading.date} · Garmin${stale ? ' · Older reading' : ''}`
            : failedDate
              ? `Garmin could not check ${failedDate}; retry the saved sync`
              : checked
                ? 'No verified measurement available'
                : 'Sync health data to check'}
        </p>
      )}
      {compact && stale && <p>Older reading</p>}
      {!compact && reading && <p>Date timezone: {reading.timezone} (inferred)</p>}
    </div>
  )
}

/** Reusable dated summary for Health now and Dashboard in RUN-43. */
export function HealthSnapshot({
  data,
  asOfInstant,
  failedSleepDate,
  variant = 'default',
}: {
  data: HealthSnapshotData
  asOfInstant: string
  failedSleepDate?: string | null
  variant?: 'default' | 'compact'
}) {
  const clientReady = useClientReady()
  return (
    <Card
      as="section"
      className={`${styles.card} ${variant === 'compact' ? styles.compact : ''}`}
      aria-labelledby="health-snapshot-heading"
    >
      <SectionHeading
        icon={variant === 'compact' ? Heart : HeartPulse}
        id="health-snapshot-heading"
        title={variant === 'compact' ? 'Health snapshot' : 'Latest health measurements'}
        subtitle={variant === 'compact' ? 'Latest available' : 'Garmin daily health data'}
      />
      <dl className={styles.grid}>
        <Measurement
          label={variant === 'compact' ? 'Resting HR' : 'Resting heart rate'}
          reading={data.restingHr}
          unit="bpm"
          format={(value) => String(value)}
          asOfInstant={asOfInstant}
          checked={data.restingHrChecked}
          compact={variant === 'compact'}
          icon={variant === 'compact' ? HeartPulse : undefined}
        />
        <Measurement
          label={variant === 'compact' ? 'Sleep' : 'Sleep duration'}
          reading={data.sleep}
          unit=""
          format={(value) => {
            const minutes = Math.round(value / 60_000)
            return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
          }}
          asOfInstant={asOfInstant}
          checked={data.sleepChecked}
          failedDate={failedSleepDate}
          compact={variant === 'compact'}
          icon={variant === 'compact' ? BedDouble : undefined}
        />
        {variant === 'compact' && (
          <Measurement
            label="Sleep Score"
            reading={data.sleepScore ?? null}
            unit="/100"
            format={String}
            asOfInstant={asOfInstant}
            checked={data.sleepChecked}
            compact
            icon={MoonStar}
          />
        )}
      </dl>
      {variant !== 'compact' && (
        <p className={styles.note}>
          {data.lastUpdatedAt
            ? `Last Garmin health check: ${clientReady ? (formatLocalDateTime(data.lastUpdatedAt) ?? 'Time unavailable') : 'Loading local time…'}`
            : 'No Garmin health check yet.'}
        </p>
      )}
      {variant === 'compact' && (
        <footer className={styles.footer}>
          <p>
            <Info size={20} strokeWidth={2} aria-hidden="true" focusable="false" />
            Latest health metrics from Garmin. View full trends in Health.
          </p>
          <Link href="/app/health">
            Open Health{' '}
            <ArrowRight size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
          </Link>
        </footer>
      )}
    </Card>
  )
}
