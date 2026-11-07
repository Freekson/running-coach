import { describe, expect, it } from 'vitest'
import {
  buildWeightChart,
  readingDateKey,
  sortWeightReadings,
  type WeightReading,
} from './weight-history'

function reading(
  id: string,
  year: number,
  month: number,
  day: number,
  valueKg: number,
  createdAt?: string,
): WeightReading {
  return {
    id,
    measuredAt: new Date(year, month - 1, day, 12).toISOString(),
    measuredOn: null,
    createdAt: createdAt ?? new Date(year, month - 1, day, 13).toISOString(),
    valueKg,
  }
}

describe('weight chart data', () => {
  it('keeps a chosen calendar date independent of the timestamp timezone', () => {
    const chosen = {
      id: 'timezone-change',
      measuredAt: '2026-11-06T22:00:00.000Z',
      measuredOn: '2026-11-07',
      createdAt: '2026-11-07T10:00:00.000Z',
      valueKg: 70,
    }
    expect(readingDateKey(chosen)).toBe('2026-11-07')
    expect(buildWeightChart([chosen], '7D', new Date(2026, 10, 7, 12)).points).toMatchObject([
      { date: '2026-11-07', valueKg: 70 },
    ])
  })

  it('orders chart points by their displayed dates across timezones', () => {
    const readings: WeightReading[] = [
      {
        id: 'monday-east',
        measuredOn: '2026-11-02',
        measuredAt: '2026-11-01T22:00:00.000Z',
        createdAt: '2026-11-02T06:00:00.000Z',
        valueKg: 70,
      },
      {
        id: 'sunday-west',
        measuredOn: '2026-11-01',
        measuredAt: '2026-11-02T00:00:00.000Z',
        createdAt: '2026-11-02T05:00:00.000Z',
        valueKg: 72,
      },
    ]
    const today = new Date(2026, 10, 3, 12)
    const daily = buildWeightChart(readings, '7D', today)
    expect(daily.points.map((point) => point.date)).toEqual(['2026-11-01', '2026-11-02'])
    expect(daily.changeKg).toBe(-2)
    const all = buildWeightChart(readings, 'ALL', today)
    expect(all.startDate).toBe('2026-11-01')
    expect(all.points.map((point) => point.id)).toEqual(['2026-10-26', '2026-11-02'])
  })

  it('sorts deterministically and keeps the last recorded weight per local date', () => {
    const first = reading('a', 2026, 11, 5, 70, '2026-11-05T13:00:00.000Z')
    const later = reading('b', 2026, 11, 5, 71, '2026-11-05T14:00:00.000Z')
    const tied = reading('c', 2026, 11, 5, 72, '2026-11-05T14:00:00.000Z')
    const old = reading('older', 2026, 11, 1, 74)
    expect(sortWeightReadings([first, tied, old, later]).map((item) => item.id)).toEqual([
      'c',
      'b',
      'a',
      'older',
    ])
    const chart = buildWeightChart([first, tied, old, later], '7D', new Date(2026, 10, 7, 12))
    expect(chart.points.map((point) => point.valueKg)).toEqual([74, 72])
    expect(chart.changeKg).toBe(-2)
    expect(chart.weekly).toBe(false)
  })

  it('uses weekly averages when a longer range contains many daily readings', () => {
    const readings = Array.from({ length: 61 }, (_, index) =>
      reading(`reading-${index}`, 2026, 10, index + 1, 80 + index / 10),
    )
    const chart = buildWeightChart(readings, '90D', new Date(2026, 11, 1, 12))
    expect(chart.weekly).toBe(true)
    expect(chart.points.length).toBeLessThan(readings.length)
    expect(chart.points.every((point) => point.averageStart && point.averageEnd)).toBe(true)
    expect(chart.points[0].valueKg).toBe(80.15)
  })

  it('always uses weekly points for a sparse year and all-time range', () => {
    const readings = [reading('old', 2025, 1, 1, 90), reading('recent', 2026, 11, 7, 80)]
    expect(
      buildWeightChart(readings, '30D', new Date(2026, 10, 7, 12)).points.map((point) => point.id),
    ).toEqual(['recent'])
    const year = buildWeightChart(readings, '1Y', new Date(2026, 10, 7, 12))
    expect(year.weekly).toBe(true)
    expect(year.points).toHaveLength(1)
    expect(year.points[0].averageStart).toBeDefined()
    const all = buildWeightChart(readings, 'ALL', new Date(2026, 10, 7, 12))
    expect(all.weekly).toBe(true)
    expect(all.points.map((point) => point.valueKg)).toEqual([90, 80])
    expect(all.points.every((point) => point.averageStart && point.averageEnd)).toBe(true)
  })

  it('averages all measurements into one point per calendar week', () => {
    const readings = [
      reading('monday', 2026, 10, 26, 70),
      reading('tuesday-old', 2026, 10, 27, 72, '2026-10-27T13:00:00.000Z'),
      reading('tuesday-new', 2026, 10, 27, 76, '2026-10-27T14:00:00.000Z'),
      reading('next-week', 2026, 11, 2, 74),
    ]
    const chart = buildWeightChart(readings, '1Y', new Date(2026, 10, 7, 12))
    expect(chart.points).toMatchObject([
      {
        id: '2026-10-26',
        date: '2026-11-01',
        valueKg: 218 / 3,
        averageStart: '2026-10-26',
        averageEnd: '2026-11-01',
      },
      {
        id: '2026-11-02',
        date: '2026-11-07',
        valueKg: 74,
        averageStart: '2026-11-02',
        averageEnd: '2026-11-07',
      },
    ])
    expect(chart.changeKg).toBeCloseTo(74 - 218 / 3)
  })
})
