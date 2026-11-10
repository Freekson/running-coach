import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { HealthSnapshotData } from '@/lib/health-snapshot'
import { HealthSnapshot } from './HealthSnapshot'

const empty: HealthSnapshotData = {
  restingHr: null,
  sleep: null,
  restingHrChecked: false,
  sleepChecked: false,
  lastUpdatedAt: null,
}

function render(data: HealthSnapshotData, asOfInstant = '2026-11-08T12:00:00.000Z') {
  return renderToStaticMarkup(<HealthSnapshot data={data} asOfInstant={asOfInstant} />)
}

it('shows an honest empty state without unsupported metrics or import controls', () => {
  const markup = render(empty)
  expect(markup).toContain('Not checked yet')
  expect(markup).toContain('No Garmin health check yet')
  expect(markup).not.toContain('Update health data')
  expect(markup).not.toContain('Body Battery')
})

it('shows no data after a checked day with no verified values', () => {
  const markup = render({ ...empty, restingHrChecked: true, sleepChecked: true })
  expect(markup).toContain('No data')
  expect(markup).toContain('No verified measurement available')
})

it('distinguishes a failed sleep request from never checked and checked empty', () => {
  const markup = renderToStaticMarkup(
    <HealthSnapshot data={empty} asOfInstant="2026-11-09T08:00:00Z" failedSleepDate="2026-11-07" />,
  )
  expect(markup).toContain('Request failed')
  expect(markup).toContain('Garmin could not check 2026-11-07')
  expect(markup).not.toContain('No verified measurement available')
})

it('shows each measured date, source, unit and last successful update', () => {
  const markup = render({
    restingHr: {
      value: 53,
      date: '2026-11-07',
      timezone: 'Europe/Kyiv',
      fetchedAt: '2026-11-08T08:00:00.000Z',
    },
    sleep: {
      value: 25_200_000,
      date: '2026-11-06',
      timezone: 'Europe/Kyiv',
      fetchedAt: '2026-11-08T08:00:00.000Z',
    },
    restingHrChecked: true,
    sleepChecked: true,
    lastUpdatedAt: '2026-11-08T08:00:00.000Z',
  })
  expect(markup).toContain('53 bpm')
  expect(markup).toContain('7 h 0 min')
  expect(markup).toContain('2026-11-07 · Garmin')
  expect(markup).toContain('2026-11-06 · Garmin')
  expect(markup).toContain('Date timezone: Europe/Kyiv (inferred)')
  expect(markup).toContain('Last Garmin health check: Loading local time')
})

it('marks an old reading across the athlete-local midnight', () => {
  const markup = render(
    {
      ...empty,
      restingHr: {
        value: 54,
        date: '2026-11-01',
        timezone: 'Asia/Tokyo',
        fetchedAt: '2026-11-01T08:00:00.000Z',
      },
      restingHrChecked: true,
    },
    '2026-11-08T15:30:00.000Z',
  )
  expect(markup).toContain('Older reading')
})
