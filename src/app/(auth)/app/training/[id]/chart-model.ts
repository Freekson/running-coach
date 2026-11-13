import type { ActivitySample } from '@/lib/activity-detail'
import { activitySampleGapSeconds } from '@/lib/activity-detail'
import type { MeasurementSystem } from '@/lib/measurement-system'

export type ChartMetric = 'speedMps' | 'heartRateBpm' | 'powerWatts' | 'cadence' | 'elevationMeters'
export const chartMetrics: { key: ChartMetric; label: string; color: string }[] = [
  { key: 'speedMps', label: 'Pace / speed', color: 'var(--color-primary)' },
  { key: 'heartRateBpm', label: 'Heart rate', color: 'var(--color-error)' },
  { key: 'powerWatts', label: 'Power', color: 'var(--color-sleep-rem)' },
  { key: 'cadence', label: 'Cadence', color: 'var(--color-sleep-deep)' },
  { key: 'elevationMeters', label: 'Elevation', color: 'var(--color-primary)' },
]
export function chartValue(
  sample: ActivitySample,
  key: ChartMetric,
  running: boolean,
  system: MeasurementSystem,
) {
  const value = sample[key]
  if (value === null) return null
  if (key === 'speedMps')
    return running
      ? value <= 0
        ? null
        : (system === 'IMPERIAL' ? 1609.344 : 1000) / value
      : value * (system === 'IMPERIAL' ? 2.2369362921 : 3.6)
  if (key === 'elevationMeters' && system === 'IMPERIAL') return value * 3.280839895
  return value
}
export function chartValueLabel(
  value: number | null,
  key: ChartMetric,
  running: boolean,
  imperial: boolean,
  cadenceUnit: string,
) {
  if (value === null) return 'Unavailable'
  if (key === 'speedMps') {
    const seconds = Math.round(value)
    return running
      ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} /${imperial ? 'mi' : 'km'}`
      : `${value.toFixed(1)} ${imperial ? 'mph' : 'km/h'}`
  }
  return `${Math.round(value)} ${key === 'heartRateBpm' ? 'bpm' : key === 'powerWatts' ? 'W' : key === 'cadence' ? cadenceUnit : imperial ? 'ft' : 'm'}`
}
/** Trailing time window; never fills missing measurements or smooths through recording gaps. */
export function smoothValues(
  samples: ActivitySample[],
  values: (number | null)[],
  seconds: number,
  metric?: ChartMetric,
) {
  if (seconds === 0) return values
  const gap = activitySampleGapSeconds(samples)
  let first = 0,
    sum = 0,
    count = 0
  return values.map((value, index) => {
    if (
      value === null ||
      (index > 0 && samples[index].timeSeconds - samples[index - 1].timeSeconds > gap) ||
      (metric !== undefined && samples[index].breakBefore?.includes(metric))
    ) {
      first = index
      sum = 0
      count = 0
    }
    if (value === null) {
      first = index + 1
      return null
    }
    sum += value
    count++
    while (first < index && samples[first].timeSeconds < samples[index].timeSeconds - seconds) {
      if (values[first] !== null) {
        sum -= values[first]!
        count--
      }
      first++
    }
    return sum / count
  })
}
