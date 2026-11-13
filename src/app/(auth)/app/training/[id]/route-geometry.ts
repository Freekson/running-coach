import type { ActivitySample } from '@/lib/activity-detail'
import { activitySampleGapSeconds } from '@/lib/activity-detail'

/** Unwrap the dateline and preserve missing fixes as breaks in the local overlay. */
export function routeGeometry(samples: ActivitySample[]) {
  const points: [number, number][] = []
  const segments: [number, number][][] = []
  let segment: [number, number][] = []
  let previousTime: number | null = null
  const gap = activitySampleGapSeconds(samples)
  for (const sample of samples) {
    if (sample.latitude === null || sample.longitude === null) {
      segment = []
      previousTime = null
      continue
    }
    const previous = points.at(-1)
    const longitude = previous
      ? sample.longitude + Math.round((previous[0] - sample.longitude) / 360) * 360
      : sample.longitude
    const point: [number, number] = [longitude, sample.latitude]
    if (
      previousTime === null ||
      sample.timeSeconds - previousTime > gap ||
      sample.breakBefore?.includes('position')
    ) {
      segment = []
      segments.push(segment)
    }
    segment.push(point)
    points.push(point)
    previousTime = sample.timeSeconds
  }
  return {
    points,
    lines: segments.filter((part) => part.length >= 2),
    bounds: points.length
      ? ([
          [
            Math.min(...points.map((point) => point[0])),
            Math.min(...points.map((point) => point[1])),
          ],
          [
            Math.max(...points.map((point) => point[0])),
            Math.max(...points.map((point) => point[1])),
          ],
        ] satisfies [[number, number], [number, number]])
      : null,
  }
}
