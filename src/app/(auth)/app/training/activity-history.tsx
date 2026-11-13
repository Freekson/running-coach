'use client'

import { useEffect, useRef, useState, useTransition, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Activity, Bike, ChevronLeft, ChevronRight, Footprints, Waves } from 'lucide-react'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { FormField } from '@/components/ui/FormField'
import { DateField } from '@/components/ui/DateField'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { Select } from '@/components/ui/Select'
import { useMeasurementSystem } from '../measurement-system-provider'
import {
  activityHistoryQuerySchema,
  activityDistanceOptionsFor,
  defaultActivityHistoryQuery,
  activityHistoryUrl,
  activityProviderLabel,
  activitySportLabel,
  formatActivityMetrics,
  type ActivityHistoryPage,
  type ActivityHistoryQuery,
} from '@/lib/activity-history'
import { ActivitySkeletonRows, ActivityTableHead } from './activity-history-skeleton'
import { useActivityTimezone } from './use-activity-timezone'
import styles from './training.module.scss'

const dateRanges = [
  { value: 'all', label: 'All time' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last year' },
  { value: 'custom', label: 'Custom dates' },
] as const
const sorts = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'distance', label: 'Longest distance' },
] as const

export function ActivityHistory({
  data,
  query,
}: {
  data: ActivityHistoryPage
  query: ActivityHistoryQuery
}) {
  const router = useRouter()
  const { system } = useMeasurementSystem()
  const [draft, setDraft] = useState(query)
  const latestDraft = useRef(query)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastNavigation = useRef(activityHistoryUrl(query))
  useEffect(
    () => () => {
      if (searchTimer.current !== null) clearTimeout(searchTimer.current)
    },
    [],
  )
  const [error, setError] = useState('')
  const [pending, startTransition] = useTransition()
  const [loadingRows, setLoadingRows] = useState<number>(query.pageSize)
  const table = useRef<HTMLTableElement>(null)
  const [reservedHeight, setReservedHeight] = useState(0)
  const local = useActivityTimezone(data.timezone)
  const busy = pending || !local.ready
  const activeCount = [
    query.q,
    query.sport,
    query.provider,
    query.range !== 'all',
    query.minDistance !== '',
  ].filter(Boolean).length
  function navigate(next: ActivityHistoryQuery, rows: number = next.pageSize) {
    cancelSearch()
    const url = activityHistoryUrl(next)
    latestDraft.current = next
    setDraft(next)
    if (url === lastNavigation.current) return
    lastNavigation.current = url
    setLoadingRows(rows)
    setReservedHeight(table.current?.getBoundingClientRect().height ?? 0)
    startTransition(() => router.push(url, { scroll: false }))
  }
  function cancelSearch() {
    if (searchTimer.current !== null) clearTimeout(searchTimer.current)
    searchTimer.current = null
  }
  function commitFilters(next: ActivityHistoryQuery) {
    cancelSearch()
    const result = activityHistoryQuerySchema.safeParse({
      ...next,
      page: 1,
      ...(next.range !== 'custom' ? { from: '', to: '' } : {}),
    })
    if (!result.success) {
      setError('Check the date range and minimum distance, then try again.')
      return
    }
    setError('')
    navigate(result.data)
  }
  function changeFilters(next: ActivityHistoryQuery, debounce = false) {
    setDraft(next)
    latestDraft.current = next
    cancelSearch()
    if (debounce) searchTimer.current = setTimeout(() => commitFilters(latestDraft.current), 700)
    else commitFilters(next)
  }
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    commitFilters(latestDraft.current)
  }
  function changePage(page: number, rows: number) {
    if (searchTimer.current !== null) commitFilters(latestDraft.current)
    else navigate({ ...query, page }, rows)
  }
  const selectedSport =
    query.sport && !data.sports.includes(query.sport) ? [query.sport, ...data.sports] : data.sports
  return (
    <Card
      as="section"
      className={styles.history}
      aria-labelledby="activities-heading"
      aria-busy={busy}
    >
      <div className={styles.filters}>
        <div className={styles.sectionHeader}>
          <SectionHeading
            icon={Activity}
            id="activities-heading"
            title="Activities"
            subtitle="Running, cycling, walking and other sports"
          />
          <span className={styles.count}>
            {data.importedCount.toLocaleString('en-US')} imported
          </span>
        </div>
        <form onSubmit={apply} aria-label="Activity filters">
          <fieldset disabled={pending} className={styles.filterFields}>
            <FormField
              id="activity-search"
              label="Search activities"
              type="search"
              placeholder="Search by name…"
              maxLength={120}
              value={draft.q}
              onChange={(event) =>
                changeFilters({ ...latestDraft.current, q: event.target.value }, true)
              }
            />
            <Select
              id="activity-sport"
              label="Sport"
              value={draft.sport}
              options={[
                { value: '', label: 'All sports' },
                ...selectedSport.map((value) => ({ value, label: activitySportLabel(value) })),
              ]}
              onChange={(sport) => {
                const minDistance = activityDistanceOptionsFor(sport).some(
                  (option) => option.value === draft.minDistance,
                )
                  ? draft.minDistance
                  : ''
                const result = activityHistoryQuerySchema.safeParse({
                  ...draft,
                  sport,
                  minDistance,
                })
                if (result.success) changeFilters(result.data)
              }}
            />
            <Select
              id="activity-range"
              label="Date range"
              value={draft.range}
              options={dateRanges}
              onChange={(range) => changeFilters({ ...latestDraft.current, range })}
            />
            <Select
              id="activity-min-distance"
              label="Minimum distance"
              value={draft.minDistance}
              options={activityDistanceOptionsFor(draft.sport)}
              onChange={(minDistance) => {
                const result = activityHistoryQuerySchema.safeParse({ ...draft, minDistance })
                if (result.success) changeFilters(result.data)
              }}
            />
            {data.providers.length > 1 && (
              <Select
                id="activity-provider"
                label="Source"
                value={draft.provider}
                options={[
                  { value: '', label: 'All sources' },
                  ...data.providers.map((value) => ({
                    value,
                    label: activityProviderLabel(value),
                  })),
                ]}
                onChange={(provider) => {
                  const parsed = activityHistoryQuerySchema.safeParse({ ...draft, provider })
                  if (parsed.success) changeFilters(parsed.data)
                }}
              />
            )}
            {draft.range === 'custom' && (
              <div className={styles.dateFields}>
                <DateField
                  id="activity-from"
                  label="From"
                  value={draft.from}
                  min={data.dateBounds.min}
                  max={draft.to && draft.to < data.dateBounds.max ? draft.to : data.dateBounds.max}
                  onChange={(from) => changeFilters({ ...latestDraft.current, from })}
                  optional
                />
                <DateField
                  id="activity-to"
                  label="To"
                  value={draft.to}
                  min={
                    draft.from && draft.from > data.dateBounds.min
                      ? draft.from
                      : data.dateBounds.min
                  }
                  max={data.dateBounds.max}
                  onChange={(to) => changeFilters({ ...latestDraft.current, to })}
                  optional
                />
              </div>
            )}
            <div className={styles.filterActions}>
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  setError('')
                  changeFilters(defaultActivityHistoryQuery)
                }}
              >
                Reset filters
              </Button>
              <span className={styles.filterSummary}>
                {activeCount
                  ? `${activeCount} ${activeCount === 1 ? 'filter' : 'filters'} applied`
                  : 'No filters applied'}
              </span>
            </div>
          </fieldset>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </form>
      </div>
      <div className={styles.resultsHeader}>
        <span className={styles.resultCount} role="status" aria-live="polite">
          {data.total.toLocaleString('en-US')} {data.total === 1 ? 'activity' : 'activities'} found
        </span>
        <Select
          id="activity-sort"
          label="Sort by"
          value={draft.sort}
          options={sorts}
          disabled={pending}
          onChange={(sort) => changeFilters({ ...latestDraft.current, sort })}
        />
      </div>
      {busy && (
        <span role="status" className={styles.visuallyHidden}>
          Loading activities…
        </span>
      )}
      <div style={busy && reservedHeight ? { minHeight: reservedHeight } : undefined}>
        {busy || data.items.length ? (
          <table ref={table} className={styles.table}>
            <caption className={styles.visuallyHidden}>Imported activity history.</caption>
            <ActivityTableHead />
            <tbody>
              {busy ? (
                <ActivitySkeletonRows rows={pending ? loadingRows : query.pageSize} />
              ) : (
                data.items.map((row) => {
                  const metric = formatActivityMetrics(row, system)
                  const sport = activitySportLabel(row.sport, row.sourceSport)
                  const Icon =
                    row.sport === 'CYCLING'
                      ? Bike
                      : row.sport === 'SWIMMING'
                        ? Waves
                        : row.sport === 'RUNNING' || row.sport === 'WALKING'
                          ? Footprints
                          : Activity
                  const date = new Intl.DateTimeFormat('en-US', {
                    timeZone: local.timezone ?? data.timezone,
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                  }).format(new Date(row.startedAt))
                  return (
                    <tr key={row.id}>
                      <td className={styles.date} data-label="Date">
                        <time dateTime={row.startedAt}>{date}</time>
                      </td>
                      <th scope="row" className={styles.activityName}>
                        <span className={styles.sportIcon}>
                          <Icon size={20} strokeWidth={2} aria-hidden="true" focusable="false" />
                        </span>
                        <span>
                          <Link
                            href={`/app/training/${row.id}?${new URLSearchParams({ back: activityHistoryUrl(query) })}`}
                          >
                            <strong>{row.title || `${sport} activity`}</strong>
                          </Link>
                          <small>
                            {sport} · {activityProviderLabel(row.provider)}
                          </small>
                        </span>
                      </th>
                      <td data-label="Distance">{metric.distance}</td>
                      <td data-label="Duration">
                        <span>
                          {metric.duration}
                          <small>{metric.durationKind}</small>
                        </span>
                      </td>
                      <td data-label="Pace / speed">{metric.paceOrSpeed}</td>
                      <td data-label="Avg HR">{metric.heartRate}</td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        ) : (
          <div className={styles.empty}>
            <h3>
              {activeCount
                ? 'No activities match your filters'
                : data.imported
                  ? 'No activities yet'
                  : 'Import your activities to get started'}
            </h3>
            <p>
              {activeCount
                ? 'Try a different search or reset the filters above.'
                : data.imported
                  ? 'Your import completed without activities. New saved workouts will appear here.'
                  : 'Import Activities in Settings. Your saved workouts will then appear here.'}
            </p>
            {!activeCount && (
              <ButtonLink href="/app/settings" variant="secondary">
                Open Settings
              </ButtonLink>
            )}
          </div>
        )}
      </div>
      <footer className={styles.footer}>
        <span>
          {data.total
            ? `Showing ${(data.page - 1) * data.pageSize + 1}–${Math.min(data.page * data.pageSize, data.total)} of ${data.total.toLocaleString('en-US')}`
            : 'Showing 0 activities'}
        </span>
        <nav aria-label="Activity pages" className={styles.pagination}>
          <Button
            variant="secondary"
            onClick={() =>
              changePage(
                data.page - 1,
                Math.min(
                  query.pageSize,
                  Math.max(0, data.total - (data.page - 2) * query.pageSize),
                ),
              )
            }
            disabled={pending || data.page <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
          </Button>
          <span aria-current="page">
            {data.page} / {data.pageCount}
          </span>
          <Button
            variant="secondary"
            onClick={() =>
              changePage(
                data.page + 1,
                Math.min(query.pageSize, Math.max(0, data.total - data.page * query.pageSize)),
              )
            }
            disabled={pending || data.page >= data.pageCount}
            aria-label="Next page"
          >
            <ChevronRight size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
          </Button>
        </nav>
        <Select
          id="activity-page-size"
          label="Per page"
          value={String(draft.pageSize)}
          options={[
            { value: '10', label: '10 / page' },
            { value: '25', label: '25 / page' },
            { value: '50', label: '50 / page' },
          ]}
          disabled={pending}
          onChange={(value) => {
            const result = activityHistoryQuerySchema.safeParse({
              ...latestDraft.current,
              page: 1,
              pageSize: value,
            })
            if (result.success) changeFilters(result.data)
          }}
        />
      </footer>
    </Card>
  )
}
