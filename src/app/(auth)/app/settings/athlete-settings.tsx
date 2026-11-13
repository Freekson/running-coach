'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Dumbbell, Ruler, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Dialog } from '@/components/ui/Dialog'
import { DateField } from '@/components/ui/DateField'
import { FormField } from '@/components/ui/FormField'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { useToast } from '@/components/ui/Toast'
import type { MeasurementSystem } from '@/lib/measurement-system'
import type { ProviderConnectionStatus } from '@/lib/provider-connection-status'
import type { GarminImportStreamState } from '@/server/garmin/data-import'
import type { ProfilePatch } from '@/server/athlete/profile'
import { useMeasurementSystem } from '../measurement-system-provider'
import { useNavigationGuard } from '../navigation-guard'
import { TrainingExperienceSelect, type TrainingExperience } from './training-experience-select'
import { useClientReady } from '@/lib/use-client-ready'
import { ProviderCredentials } from './provider-credentials'
import styles from './athlete-settings.module.scss'

type Profile = {
  displayName: string | null
  birthDate: string | null
  sex: string | null
  heightCm: number | null
  experienceLevel: TrainingExperience
  measurementSystem: MeasurementSystem
  defaultTrainingDaysPerWeek: number | null
  defaultAvailableWeekdays: number[] | null
}
type Settings = { profile: Profile }

const weekdays = [
  { value: 1, label: 'Mon', full: 'Monday' },
  { value: 2, label: 'Tue', full: 'Tuesday' },
  { value: 3, label: 'Wed', full: 'Wednesday' },
  { value: 4, label: 'Thu', full: 'Thursday' },
  { value: 5, label: 'Fri', full: 'Friday' },
  { value: 6, label: 'Sat', full: 'Saturday' },
  { value: 0, label: 'Sun', full: 'Sunday' },
]

function todayLocal() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

export function AthleteSettingsRoute({
  initial,
  registrationName,
  garminConnection,
  garminImports,
  garminImportPreferenceKey,
}: {
  initial: Settings
  registrationName: string | null
  garminConnection: ProviderConnectionStatus
  garminImports: GarminImportStreamState[]
  garminImportPreferenceKey?: string
}) {
  const router = useRouter()
  return (
    <AthleteSettings
      initial={initial}
      registrationName={registrationName}
      garminConnection={garminConnection}
      garminImports={garminImports}
      garminImportPreferenceKey={garminImportPreferenceKey}
      onProfileSaved={() => router.refresh()}
    />
  )
}

export function AthleteSettings({
  initial,
  registrationName,
  garminConnection,
  garminImports,
  garminImportPreferenceKey,
  onProfileSaved,
}: {
  initial: Settings
  registrationName?: string | null
  garminConnection?: ProviderConnectionStatus
  garminImports?: GarminImportStreamState[]
  garminImportPreferenceKey?: string
  onProfileSaved?: () => void
}) {
  const { system, setSystem } = useMeasurementSystem()
  const { registerBlocker } = useNavigationGuard()
  const toast = useToast()
  const [profile, setProfile] = useState(initial.profile)
  const [patch, setPatch] = useState<ProfilePatch>({})
  const [unsavedOpen, setUnsavedOpen] = useState(false)
  const [formVersion, setFormVersion] = useState(0)
  const [profilePending, setProfilePending] = useState(false)
  const [profileMessage, setProfileMessage] = useState('')
  const [unitPending, setUnitPending] = useState(false)
  const [unitMessage, setUnitMessage] = useState('')
  const clientReady = useClientReady()
  const localToday = clientReady ? todayLocal() : ''
  const pendingNavigation = useRef<(() => void) | null>(null)
  const allowUnload = useRef(false)
  const current = { ...profile, ...patch }
  const hasUnsavedChanges = Object.entries(patch).some(
    ([field, value]) =>
      JSON.stringify(value) !==
      JSON.stringify(
        field === 'displayName'
          ? (profile.displayName ?? registrationName ?? null)
          : profile[field as keyof Profile],
      ),
  )
  const displayName =
    patch.displayName !== undefined
      ? (patch.displayName ?? '')
      : (profile.displayName ?? registrationName ?? '')
  const selectedDays = current.defaultAvailableWeekdays ?? []

  useEffect(() => {
    if (!hasUnsavedChanges) return
    allowUnload.current = false
    return registerBlocker((proceed) => {
      pendingNavigation.current = proceed
      setProfileMessage('')
      setUnsavedOpen(true)
    })
  }, [hasUnsavedChanges, registerBlocker])

  useEffect(() => {
    if (!hasUnsavedChanges) return
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (allowUnload.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [hasUnsavedChanges])

  async function persistProfile(refreshShell = true, applySavedProfile = true) {
    if (profilePending || !hasUnsavedChanges) return false
    setProfilePending(true)
    setProfileMessage('')
    try {
      const response = await fetch('/api/athlete/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!response.ok) throw new Error('Save failed')
      if (applySavedProfile) {
        setProfile(current)
        setPatch({})
      }
      toast('success', 'Changes saved.', 'athlete-profile')
      if (refreshShell) onProfileSaved?.()
      return true
    } catch {
      setProfileMessage('Changes could not be saved. Check your entries and try again.')
      return false
    } finally {
      setProfilePending(false)
    }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await persistProfile()
  }

  function keepEditing() {
    pendingNavigation.current = null
    setUnsavedOpen(false)
  }

  function discardChanges() {
    const proceed = pendingNavigation.current
    pendingNavigation.current = null
    allowUnload.current = true
    proceed?.()
    setPatch({})
    setFormVersion((version) => version + 1)
    setProfileMessage('')
    setUnsavedOpen(false)
  }

  async function saveAndLeave() {
    const form = document.getElementById('athlete-profile-form') as HTMLFormElement | null
    if (!form?.checkValidity()) {
      pendingNavigation.current = null
      setUnsavedOpen(false)
      setProfileMessage('Complete the required fields before saving.')
      window.setTimeout(() => form?.reportValidity(), 0)
      return
    }
    if (!(await persistProfile(false, false))) return
    const proceed = pendingNavigation.current
    pendingNavigation.current = null
    allowUnload.current = true
    setUnsavedOpen(false)
    proceed?.()
    setProfile(current)
    setPatch({})
  }

  async function saveMeasurementSystem(next: MeasurementSystem) {
    if (unitPending || next === system) return
    setUnitPending(true)
    setUnitMessage('Saving measurement system…')
    try {
      const response = await fetch('/api/athlete/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ measurementSystem: next }),
      })
      if (!response.ok) throw new Error('Save failed')
      setSystem(next)
      setProfile((previousProfile) => ({ ...previousProfile, measurementSystem: next }))
      setUnitMessage('Measurement system saved.')
    } catch {
      setUnitMessage('Measurement system could not be saved. Try again.')
    } finally {
      setUnitPending(false)
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <h1>Athlete settings</h1>
          <p>Your profile, training preferences and integrations.</p>
        </div>
        <Button
          type="submit"
          form="athlete-profile-form"
          loading={profilePending}
          disabled={!hasUnsavedChanges || unitPending}
        >
          <Check size={18} strokeWidth={2} aria-hidden="true" />
          Save changes
        </Button>
      </header>

      <form id="athlete-profile-form" onSubmit={saveProfile} className={styles.profileForm}>
        <fieldset className={styles.profileFields} disabled={profilePending}>
          <Card as="section" className={styles.section} aria-labelledby="personal-heading">
            <SectionHeading icon={UserRound} id="personal-heading" title="Personal information" />
            <div className={styles.fields}>
              <FormField
                id="profile-name"
                label="Display name"
                optional
                placeholder="Your name"
                maxLength={120}
                value={displayName}
                onChange={(event) =>
                  setPatch({ ...patch, displayName: event.target.value || null })
                }
              />
              <DateField
                id="profile-birth"
                label="Date of birth"
                optional
                max={localToday || undefined}
                value={current.birthDate ?? ''}
                onChange={(value) => setPatch({ ...patch, birthDate: value || null })}
              />
              <fieldset className={styles.choiceField}>
                <legend>Sex</legend>
                <div className={styles.choiceGrid}>
                  {(['MALE', 'FEMALE'] as const).map((value) => (
                    <label key={value} className={styles.choice}>
                      <input
                        type="radio"
                        name="sex"
                        value={value}
                        required
                        checked={current.sex === value}
                        onChange={() => setPatch({ ...patch, sex: value })}
                      />
                      <span>{value === 'MALE' ? 'Male' : 'Female'}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <FormField
                key={`${system}-${formVersion}`}
                id="profile-height"
                label={`Height (${system === 'IMPERIAL' ? 'ft' : 'cm'})`}
                required
                type="number"
                min={system === 'IMPERIAL' ? '1.64' : '50'}
                max={system === 'IMPERIAL' ? '9.84' : '300'}
                step="0.01"
                defaultValue={
                  current.heightCm === null
                    ? ''
                    : (system === 'IMPERIAL' ? current.heightCm / 30.48 : current.heightCm).toFixed(
                        2,
                      )
                }
                onChange={(event) =>
                  setPatch({
                    ...patch,
                    heightCm: event.target.value
                      ? Math.round(
                          Number(event.target.value) * (system === 'IMPERIAL' ? 30.48 : 1) * 100,
                        ) / 100
                      : null,
                  })
                }
              />
            </div>
          </Card>

          <Card as="section" className={styles.section} aria-labelledby="training-heading">
            <SectionHeading icon={Dumbbell} id="training-heading" title="Training preferences" />
            <div className={styles.fields}>
              <TrainingExperienceSelect
                value={current.experienceLevel}
                onChange={(experienceLevel) => setPatch({ ...patch, experienceLevel })}
              />
              <div className={styles.choiceField}>
                <div className={styles.fieldLabelRow}>
                  <span id="training-days-label">Training days per week</span>
                  <button
                    type="button"
                    className={styles.textButton}
                    onClick={() => setPatch({ ...patch, defaultTrainingDaysPerWeek: null })}
                    disabled={current.defaultTrainingDaysPerWeek === null}
                  >
                    Clear
                  </button>
                </div>
                <div className={styles.dayGrid} role="group" aria-labelledby="training-days-label">
                  {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                    <button
                      key={day}
                      type="button"
                      className={styles.segment}
                      aria-pressed={current.defaultTrainingDaysPerWeek === day}
                      onClick={() => setPatch({ ...patch, defaultTrainingDaysPerWeek: day })}
                    >
                      {day}
                    </button>
                  ))}
                </div>
              </div>
              <div className={styles.choiceField}>
                <div className={styles.fieldLabelRow}>
                  <span id="preferred-weekdays-label">Preferred weekdays</span>
                  <button
                    type="button"
                    className={styles.textButton}
                    onClick={() => setPatch({ ...patch, defaultAvailableWeekdays: null })}
                    disabled={selectedDays.length === 0}
                  >
                    Clear
                  </button>
                </div>
                <div
                  className={styles.dayGrid}
                  role="group"
                  aria-labelledby="preferred-weekdays-label"
                >
                  {weekdays.map((day) => (
                    <button
                      key={day.value}
                      type="button"
                      className={styles.segment}
                      aria-label={day.full}
                      aria-pressed={selectedDays.includes(day.value)}
                      onClick={() =>
                        setPatch({
                          ...patch,
                          defaultAvailableWeekdays: selectedDays.includes(day.value)
                            ? selectedDays.filter((value) => value !== day.value)
                            : [...selectedDays, day.value].sort((a, b) => a - b),
                        })
                      }
                    >
                      {day.label}
                    </button>
                  ))}
                </div>
                <p className={styles.fieldHint}>
                  {selectedDays.length} preferred {selectedDays.length === 1 ? 'day' : 'days'}{' '}
                  selected. Changes apply to future plans.
                </p>
              </div>
            </div>
          </Card>
        </fieldset>
      </form>
      <p className={styles.status} role="status" aria-live="polite">
        {profileMessage}
      </p>

      <Card as="section" className={styles.section} aria-labelledby="units-heading">
        <div className={`${styles.sectionHeadingWithAction} ${styles.unitsHeading}`}>
          <SectionHeading
            icon={Ruler}
            id="units-heading"
            title="Units & measurements"
            subtitle="Choose one measurement system for your entire account. Changes apply across the app."
            className={styles.unitsTitle}
          />
          {unitMessage && (
            <p className={styles.unitStatus} role="status" aria-live="polite">
              {unitMessage}
            </p>
          )}
        </div>
        <fieldset className={styles.choiceField} disabled={unitPending || profilePending}>
          <legend>Measurement system</legend>
          <div className={styles.choiceGrid}>
            {(['METRIC', 'IMPERIAL'] as const).map((value) => (
              <label key={value} className={`${styles.choice} ${styles.unitChoice}`}>
                <input
                  type="radio"
                  name="measurement-system"
                  value={value}
                  checked={system === value}
                  onChange={() => void saveMeasurementSystem(value)}
                />
                <span>
                  <strong>{value === 'METRIC' ? 'Metric' : 'Imperial'}</strong>
                  <small>{value === 'METRIC' ? 'km · kg · m' : 'mi · lb · ft'}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <dl className={styles.unitDetails}>
          <div>
            <dt>Distance</dt>
            <dd>{system === 'METRIC' ? 'Kilometers (km)' : 'Miles (mi)'}</dd>
          </div>
          <div>
            <dt>Weight</dt>
            <dd>{system === 'METRIC' ? 'Kilograms (kg)' : 'Pounds (lb)'}</dd>
          </div>
          <div>
            <dt>Running pace</dt>
            <dd>{system === 'METRIC' ? 'min/km' : 'min/mi'}</dd>
          </div>
          <div>
            <dt>Elevation</dt>
            <dd>{system === 'METRIC' ? 'Meters (m)' : 'Feet (ft)'}</dd>
          </div>
        </dl>
      </Card>

      <ProviderCredentials
        initial={garminConnection}
        garminImports={garminImports}
        garminImportPreferenceKey={garminImportPreferenceKey}
      />

      <Dialog
        open={unsavedOpen}
        title="Unsaved changes"
        description="Your profile changes have not been saved. Save them before leaving or discard them."
        onClose={keepEditing}
        pending={profilePending}
        actions={
          <>
            <Button variant="secondary" onClick={discardChanges} disabled={profilePending}>
              Discard changes
            </Button>
            <Button onClick={() => void saveAndLeave()} loading={profilePending}>
              Save changes
            </Button>
          </>
        }
      >
        {profileMessage && (
          <p className={styles.error} role="alert">
            {profileMessage}
          </p>
        )}
      </Dialog>
    </main>
  )
}
