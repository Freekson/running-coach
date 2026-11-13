'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Map as RouteMap } from 'maplibre-gl'
import { LocateFixed, MapPin } from 'lucide-react'
import type { ActivityCharts } from '@/lib/activity-detail'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { routeGeometry } from './route-geometry'
import 'maplibre-gl/dist/maplibre-gl.css'
import styles from './activity-detail.module.scss'

export function ActivityRoute({ samples }: { samples: ActivityCharts['samples'] }) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<RouteMap | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const geometry = useMemo(() => routeGeometry(samples), [samples])
  const key = process.env.NEXT_PUBLIC_MAPTILER_API_KEY
  const hasRoute = geometry.points.length >= 2
  useEffect(() => {
    if (!hasRoute || !key || !container.current) return
    const element = container.current
    let disposed = false
    let initialized = false
    let map: RouteMap | undefined
    let observer: ResizeObserver | undefined
    void import('maplibre-gl')
      .then(({ Map, NavigationControl, ScaleControl, setWorkerUrl }) => {
        if (disposed) return
        setWorkerUrl(new URL('maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url).href)
        const tokens = getComputedStyle(element)
        const primary = tokens.getPropertyValue('--color-primary').trim()
        const finish = tokens.getPropertyValue('--color-error').trim()
        const border = tokens.getPropertyValue('--color-text').trim()
        map = new Map({
          container: element,
          style: `https://api.maptiler.com/maps/streets-v4-dark/style.json?key=${encodeURIComponent(key)}`,
          bounds: geometry.bounds ?? undefined,
          fitBoundsOptions: { padding: 40, maxZoom: 16, duration: 0 },
          scrollZoom: true,
          dragRotate: false,
          pitchWithRotate: false,
          attributionControl: {
            compact: true,
            customAttribution:
              '<a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener noreferrer">© MapTiler</a>',
          },
        })
        mapRef.current = map
        map.addControl(new NavigationControl({ showCompass: false }), 'top-right')
        map.addControl(new ScaleControl({ maxWidth: 100 }), 'bottom-left')
        map.on('error', () => {
          // Tile errors after initialization must not block an otherwise usable map.
          if (!disposed && !initialized) setStatus('error')
        })
        map.on('load', () => {
          if (disposed || !map) return
          map.addSource('workout-route', {
            type: 'geojson',
            data: {
              type: 'Feature',
              properties: {},
              geometry: { type: 'MultiLineString', coordinates: geometry.lines },
            },
          })
          map.addLayer({
            id: 'workout-route',
            type: 'line',
            source: 'workout-route',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': primary, 'line-width': 4 },
          })
          map.addSource('workout-endpoints', {
            type: 'geojson',
            data: {
              type: 'FeatureCollection',
              features: [geometry.points[0], geometry.points.at(-1)!].map((coordinates, index) => ({
                type: 'Feature',
                properties: { finish: index === 1 },
                geometry: { type: 'Point', coordinates },
              })),
            },
          })
          map.addLayer({
            id: 'workout-endpoints',
            type: 'circle',
            source: 'workout-endpoints',
            paint: {
              'circle-radius': 6,
              'circle-color': ['case', ['get', 'finish'], finish, primary],
              'circle-stroke-width': 2,
              'circle-stroke-color': border,
            },
          })
          initialized = true
          setStatus('ready')
        })
        observer = new ResizeObserver(() => map?.resize())
        observer.observe(element)
      })
      .catch(() => {
        if (!disposed) setStatus('error')
      })
    return () => {
      disposed = true
      observer?.disconnect()
      mapRef.current = null
      map?.remove()
    }
  }, [geometry, hasRoute, key, attempt])

  return (
    <Card as="section" className={styles.routeCard} aria-labelledby="route-heading">
      <div className={styles.sectionBar}>
        <SectionHeading id="route-heading" icon={MapPin} title="Route" />
        {hasRoute && key && (
          <Button
            size="compact"
            variant="secondary"
            aria-label="Fit route to map"
            disabled={status !== 'ready'}
            onClick={() => {
              if (geometry.bounds)
                mapRef.current?.fitBounds(geometry.bounds, {
                  padding: 40,
                  maxZoom: 16,
                  duration: 0,
                })
            }}
          >
            <LocateFixed size={18} aria-hidden="true" />
          </Button>
        )}
      </div>
      {hasRoute && key ? (
        <>
          <div className={styles.mapFrame}>
            <div
              ref={container}
              className={styles.routeMap}
              role="region"
              aria-label="Workout route map"
              aria-busy={status === 'loading'}
            />
            {status === 'error' && (
              <div className={styles.mapError} role="status">
                <p>The map could not be loaded.</p>
                <Button
                  size="compact"
                  variant="secondary"
                  onClick={() => {
                    setStatus('loading')
                    setAttempt((value) => value + 1)
                  }}
                >
                  Retry map
                </Button>
              </div>
            )}
          </div>
          <p className={styles.caption}>
            <span className={styles.startDot} /> Start <span className={styles.endDot} /> Finish
          </p>
        </>
      ) : (
        <div className={styles.routeEmpty}>
          <MapPin size={28} aria-hidden="true" />
          <strong>{hasRoute ? 'Map unavailable' : 'No GPS route recorded'}</strong>
          <p>
            {hasRoute
              ? 'The map service is not configured.'
              : 'This workout has no usable route coordinates. Other recorded charts remain available.'}
          </p>
        </div>
      )}
    </Card>
  )
}
