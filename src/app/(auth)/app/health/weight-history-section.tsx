'use client'

import { useRef, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/Button'
import { DateField } from '@/components/ui/DateField'
import { Dialog } from '@/components/ui/Dialog'
import { FormField } from '@/components/ui/FormField'
import { weightUnitFor } from '@/lib/measurement-system'
import { useMeasurementSystem } from '../measurement-system-provider'
import { WeightHistoryPanel } from '../settings/weight-history-panel'
import {
  sortWeightReadings,
  type ChartPeriod,
  type WeightReading,
} from '../settings/weight-history'
import { useClientReady } from '@/lib/use-client-ready'
import styles from '../settings/athlete-settings.module.scss'

function todayLocal() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function localOffsetMinutes(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day, 12).getTimezoneOffset()
}

export function WeightHistorySection({
  initialPeriod,
  initialWeights,
  initialChartWeights,
}: {
  initialPeriod: ChartPeriod
  initialWeights: WeightReading[]
  initialChartWeights: WeightReading[]
}) {
  const { system } = useMeasurementSystem()
  const unit = weightUnitFor(system)
  const [weights, setWeights] = useState(initialWeights)
  const [addedWeights, setAddedWeights] = useState<WeightReading[]>([])
  const [weightOpen, setWeightOpen] = useState(false)
  const [weightPending, setWeightPending] = useState(false)
  const [weightMessage, setWeightMessage] = useState('')
  const [weightValue, setWeightValue] = useState('')
  const [weightDate, setWeightDate] = useState<string | null>(null)
  const clientReady = useClientReady()
  const localToday = clientReady ? todayLocal() : ''
  const selectedWeightDate = weightDate ?? localToday
  const weightAttempt = useRef<{
    id: string
    value: number
    unit: 'KG' | 'LB'
    measuredOn: string
    timezoneOffsetMinutes: number
  } | null>(null)

  async function saveWeight(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (weightPending || !selectedWeightDate || !weightValue) return
    const value = Number(weightValue)
    const timezoneOffsetMinutes = localOffsetMinutes(selectedWeightDate)
    const attempt =
      weightAttempt.current?.value === value &&
      weightAttempt.current.unit === unit &&
      weightAttempt.current.measuredOn === selectedWeightDate &&
      weightAttempt.current.timezoneOffsetMinutes === timezoneOffsetMinutes
        ? weightAttempt.current
        : {
            id: crypto.randomUUID(),
            value,
            unit,
            measuredOn: selectedWeightDate,
            timezoneOffsetMinutes,
          }
    weightAttempt.current = attempt
    setWeightPending(true)
    setWeightMessage('')
    try {
      const response = await fetch('/api/athlete/weight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          value,
          unit,
          measuredOn: selectedWeightDate,
          timezoneOffsetMinutes,
          requestId: attempt.id,
        }),
      })
      if (!response.ok) throw new Error('Save failed')
      const item: WeightReading = await response.json()
      setWeights((previousWeights) =>
        sortWeightReadings([
          item,
          ...previousWeights.filter((reading) => reading.id !== item.id),
        ]).slice(0, 3),
      )
      setAddedWeights((previousWeights) =>
        sortWeightReadings([item, ...previousWeights.filter((reading) => reading.id !== item.id)]),
      )
      weightAttempt.current = null
      setWeightValue('')
      setWeightOpen(false)
    } catch {
      setWeightMessage('Weight could not be saved. Try again.')
    } finally {
      setWeightPending(false)
    }
  }

  return (
    <div className={styles.page}>
      <WeightHistoryPanel
        initialPeriod={initialPeriod}
        recentWeights={weights}
        addedWeights={addedWeights}
        initialChartWeights={initialChartWeights}
        system={system}
        notice={weightOpen ? '' : weightMessage}
        onAdd={() => {
          setWeightDate(todayLocal())
          setWeightMessage('')
          setWeightOpen(true)
        }}
      />
      <Dialog
        open={weightOpen}
        title="Add weight reading"
        onClose={() => setWeightOpen(false)}
        pending={weightPending}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => setWeightOpen(false)}
              disabled={weightPending}
            >
              Cancel
            </Button>
            <Button type="submit" form="weight-reading-form" loading={weightPending}>
              Save reading
            </Button>
          </>
        }
      >
        <form id="weight-reading-form" onSubmit={saveWeight} className={styles.weightForm}>
          <div className={styles.weightInput}>
            <FormField
              id="weight-value"
              label="Weight"
              placeholder="Enter weight"
              type="number"
              min="0.1"
              max="1000"
              step="0.01"
              required
              value={weightValue}
              onChange={(event) => setWeightValue(event.target.value)}
              disabled={weightPending}
            />
            <span>{unit.toLowerCase()}</span>
          </div>
          <DateField
            id="weight-date"
            label="Measurement date"
            max={localToday || undefined}
            value={selectedWeightDate}
            onChange={setWeightDate}
            disabled={weightPending}
          />
          {weightMessage && (
            <p className={styles.error} role="alert">
              {weightMessage}
            </p>
          )}
        </form>
      </Dialog>
    </div>
  )
}
