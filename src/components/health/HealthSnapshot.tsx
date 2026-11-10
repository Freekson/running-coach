'use client'

import { HeartPulse } from 'lucide-react'
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
}: {
  label: string
  reading: HealthReading | null
  unit: string
  format: (value: number) => string
  asOfInstant: string
  checked: boolean
  failedDate?: string | null
}) {
  const stale = reading
    ? Date.parse(`${localDay(asOfInstant, reading.timezone)}T12:00:00Z`) -
        Date.parse(`${reading.date}T12:00:00Z`) >
      7 * 86_400_000
    : false
  return (
    <div className={styles.measurement}>
      <dt>{label}</dt>
      <dd>
        {reading
          ? `${format(reading.value)}${unit ? ` ${unit}` : ''}`
          : failedDate
            ? 'Request failed'
            : checked
              ? 'No data'
              : 'Not checked yet'}
      </dd>
      <p>
        {reading
          ? `${reading.date} · Garmin${stale ? ' · Older reading' : ''}`
          : failedDate
            ? `Garmin could not check ${failedDate}; retry the saved sync`
            : checked
              ? 'No verified measurement available'
              : 'Sync health data to check'}
      </p>
      {reading && <p>Date timezone: {reading.timezone} (inferred)</p>}
    </div>
  )
}

/** Reusable dated summary for Health now and Dashboard in RUN-43. */
export function HealthSnapshot({
  data,
  asOfInstant,
  failedSleepDate,
}: {
  data: HealthSnapshotData
  asOfInstant: string
  failedSleepDate?: string | null
}) {
  const clientReady = useClientReady()
  return (
    <Card as="section" className={styles.card} aria-labelledby="health-snapshot-heading">
      <SectionHeading
        icon={HeartPulse}
        id="health-snapshot-heading"
        title="Latest health measurements"
        subtitle="Garmin daily health data"
      />
      <dl className={styles.grid}>
        <Measurement
          label="Resting heart rate"
          reading={data.restingHr}
          unit="bpm"
          format={(value) => String(value)}
          asOfInstant={asOfInstant}
          checked={data.restingHrChecked}
        />
        <Measurement
          label="Sleep duration"
          reading={data.sleep}
          unit=""
          format={(value) => {
            const minutes = Math.round(value / 60_000)
            return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
          }}
          asOfInstant={asOfInstant}
          checked={data.sleepChecked}
          failedDate={failedSleepDate}
        />
      </dl>
      <p className={styles.note}>
        {data.lastUpdatedAt
          ? `Last Garmin health check: ${clientReady ? (formatLocalDateTime(data.lastUpdatedAt) ?? 'Time unavailable') : 'Loading local time…'}`
          : 'No Garmin health check yet.'}
      </p>
    </Card>
  )
}
