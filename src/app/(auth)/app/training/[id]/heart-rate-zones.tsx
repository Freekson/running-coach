'use client'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Heart, Info } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { activityDuration } from '@/lib/activity-detail'
import { zoneSectorPath } from './zone-sector-path'
import styles from './activity-detail.module.scss'

const colors = [
  'var(--color-text-muted)',
  'var(--color-sleep-deep)',
  'var(--color-primary)',
  'var(--color-warning)',
  'var(--color-sleep-awake)',
  'var(--color-error)',
]
const zoneDefinitions = [
  { name: 'Below range', description: 'Heart rate below the first configured zone.' },
  { name: 'Warm-up', description: 'Very light effort with relaxed, steady breathing.' },
  { name: 'Easy', description: 'Comfortable effort where holding a conversation is usually easy.' },
  {
    name: 'Aerobic',
    description: 'Moderate effort with deeper breathing; conversation becomes harder.',
  },
  {
    name: 'Threshold',
    description: 'Hard effort with forceful breathing, near the sustainable limit.',
  },
  {
    name: 'Maximum',
    description: 'Very intense, short efforts with a strong anaerobic contribution.',
  },
]
const zoneName = (index: number) => zoneDefinitions[index]?.name ?? `Zone ${index}`

function HeartRateZoneHelp() {
  const [open, setOpen] = useState(false)
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const tooltip = useRef<HTMLDivElement>(null)
  const pinned = useRef(false)

  useLayoutEffect(() => {
    const panel = tooltip.current
    const button = root.current?.querySelector('button')
    if (!open || !panel || !button || !panel.showPopover) return
    panel.showPopover()
    const position = () => {
      const anchor = button.getBoundingClientRect()
      const below = window.innerHeight - anchor.bottom - 16
      const above = anchor.top - 16
      const useBelow = below >= 360 || below >= above
      panel.style.width = `${Math.min(360, window.innerWidth - 32)}px`
      panel.style.maxHeight = `${Math.max(1, useBelow ? below : above)}px`
      panel.style.left = `${Math.max(16, Math.min(anchor.left, window.innerWidth - panel.getBoundingClientRect().width - 16))}px`
      panel.style.top = `${useBelow ? anchor.bottom + 8 : Math.max(16, anchor.top - 8 - panel.getBoundingClientRect().height)}px`
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
      if (panel.isConnected) panel.hidePopover()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        pinned.current = false
        setOpen(false)
      }
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        pinned.current = false
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  return (
    <div
      ref={root}
      className={styles.zoneHelp}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') setOpen(true)
      }}
      onPointerLeave={(event) => {
        if (
          event.pointerType !== 'touch' &&
          !pinned.current &&
          !root.current?.contains(document.activeElement)
        )
          setOpen(false)
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          pinned.current = false
          setOpen(false)
        }
      }}
    >
      <Button
        size="compact"
        variant="secondary"
        className={styles.zoneHelpButton}
        aria-label="About heart rate zones"
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onClick={() => {
          pinned.current = !pinned.current
          setOpen(pinned.current)
        }}
      >
        <Info size={18} strokeWidth={2} aria-hidden="true" />
      </Button>
      {open && (
        <div ref={tooltip} id={id} popover="manual" role="tooltip" className={styles.zoneHelpPanel}>
          <strong>Understanding heart rate zones</strong>
          <dl>
            {zoneDefinitions.map(({ name, description }, index) => (
              <div key={name}>
                <dt>
                  Z{index} · {name}
                </dt>
                <dd>{description}</dd>
              </div>
            ))}
          </dl>
          <p>
            These names describe a typical five-zone model. Recorded zone boundaries can be
            customized.
          </p>
          <p>Percentages show each zone’s share of the total recorded zone time.</p>
        </div>
      )}
    </div>
  )
}
export function HeartRateZones({ seconds }: { seconds: number[] }) {
  const [selection, setActive] = useState<number | null>(null)
  const active = selection !== null && seconds[selection] > 0 ? selection : null
  const total = seconds.reduce((sum, duration) => sum + duration, 0)
  return (
    <Card as="section" className={styles.zonesCard} aria-labelledby="zones-heading">
      <div className={styles.zoneHeading}>
        <SectionHeading id="zones-heading" icon={Heart} title="Heart rate zones" />
        <HeartRateZoneHelp />
      </div>
      {!total ? (
        <p className={styles.emptyText}>No heart rate zone durations recorded in this workout.</p>
      ) : (
        <div
          className={styles.zoneContent}
          onPointerLeave={(event) => {
            if (event.pointerType !== 'touch') setActive(null)
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setActive(null)
          }}
        >
          <svg
            viewBox="0 0 220 220"
            role="group"
            aria-label="FIT recorded time in heart rate zones"
          >
            {seconds.map((duration, index) => {
              const start = seconds.slice(0, index).reduce((sum, value) => sum + value, 0) / total
              if (!duration) return null
              return (
                <path
                  key={index}
                  d={zoneSectorPath(start, start + duration / total, active === index)}
                  fill={colors[Math.min(index, colors.length - 1)]}
                  role="button"
                  tabIndex={0}
                  aria-label={`Zone ${index}: ${zoneName(index)}, ${activityDuration(duration * 1000)}, ${Math.round((duration / total) * 100)} percent`}
                  aria-pressed={active === index}
                  onPointerEnter={() => setActive(index)}
                  onPointerLeave={(event) => {
                    if (event.pointerType !== 'touch') setActive(null)
                  }}
                  onFocus={() => setActive(index)}
                  onClick={() => setActive(index)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setActive(index)
                    }
                  }}
                />
              )
            })}
            <text x={110} y={108} textAnchor="middle" className={styles.zoneTime}>
              {activityDuration((active === null ? total : seconds[active]) * 1000)}
            </text>
            <text x={110} y={132} textAnchor="middle" className={styles.zoneLabel}>
              {active === null ? 'Total time' : zoneName(active)}
            </text>
          </svg>
          <div className={styles.zoneLegend}>
            {seconds
              .map(
                (duration, index) =>
                  duration > 0 && (
                    <button
                      key={index}
                      type="button"
                      aria-pressed={active === index}
                      onPointerEnter={() => setActive(index)}
                      onPointerLeave={(event) => {
                        if (event.pointerType !== 'touch') setActive(null)
                      }}
                      onFocus={() => setActive(index)}
                      onClick={() => setActive(active === index ? null : index)}
                    >
                      <span className={styles.zoneName}>
                        <i
                          style={{ background: colors[Math.min(index, colors.length - 1)] }}
                          aria-hidden="true"
                        />
                        <span>
                          <span className={styles.zoneCode}>Z{index}</span> {zoneName(index)}
                        </span>
                      </span>
                      <strong className={styles.zoneDuration}>
                        {activityDuration(duration * 1000)}
                      </strong>
                      <span className={styles.zonePercent}>
                        {Math.round((duration / total) * 100)}%
                      </span>
                    </button>
                  ),
              )
              .reverse()}
          </div>
        </div>
      )}
    </Card>
  )
}
