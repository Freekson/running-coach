'use client'

import { useState } from 'react'
import { ArrowUpRight, CalendarDays, Mountain, Plus, Target, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/Dialog'
import { Select } from '@/components/ui/Select'
import { GoalForm, goalTypes } from './goal-form'
import type { GoalFields, GoalType, GoalView } from './goal-view'
import styles from './goals.module.scss'

type GoalsScreenProps = {
  goals: readonly GoalView[]
  onSave: (fields: GoalFields, id?: string) => Promise<void>
  onArchive: (id: string, archived: boolean) => Promise<void>
  initialDialog?: 'create'
  onDelete?: (id: string) => Promise<void>
  onCreate?: () => void
  onEdit?: (id: string) => void
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`))
}

function GoalMetric({ goal }: { goal: GoalView }) {
  return (
    <p className={styles.metric}>
      <strong>
        {goal.type === 'CONSISTENCY'
          ? goal.sessionsPerWeek
          : goal.type === 'PERFORMANCE' && goal.targetTime
            ? goal.targetTime
            : goal.distanceKm}
      </strong>
      <span>
        {goal.type === 'CONSISTENCY'
          ? `runs / ${goal.measurementWindow.toLowerCase()}`
          : goal.type === 'PERFORMANCE' && goal.targetTime
            ? `${goal.distanceKm} km`
            : 'km target'}
      </span>
    </p>
  )
}

export function GoalsScreen({
  goals,
  onSave,
  onArchive,
  initialDialog,
  onDelete,
  onCreate,
  onEdit,
}: GoalsScreenProps) {
  const [archived, setArchived] = useState(false)
  const [filter, setFilter] = useState<'ALL' | GoalType>('ALL')
  const [editor, setEditor] = useState<GoalView | 'create' | null>(initialDialog ?? null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState<GoalView | null>(null)
  const inTab = goals.filter((goal) => goal.archived === archived)
  const visible = inTab.filter((goal) => filter === 'ALL' || goal.type === filter)

  async function archive(goal: GoalView) {
    if (pendingId) return
    setPendingId(goal.id)
    setError('')
    try {
      await onArchive(goal.id, !goal.archived)
    } catch {
      setError(
        `Your goal could not be ${goal.archived ? 'restored' : 'archived'}. Please try again.`,
      )
    } finally {
      setPendingId(null)
    }
  }

  return (
    <section className={styles.screen} aria-labelledby="goals-title">
      <header className={styles.header}>
        <div>
          <h1 id="goals-title">Goals</h1>
          <p>Define what you want to achieve.</p>
        </div>
        <Button onClick={() => (onCreate ? onCreate() : setEditor('create'))}>
          <Plus size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
          New goal
        </Button>
      </header>
      <div className={styles.tabs} role="group" aria-label="Goal status">
        <button
          type="button"
          aria-pressed={!archived}
          onClick={() => {
            setArchived(false)
            setError('')
          }}
        >
          Active goals
        </button>
        <button
          type="button"
          aria-pressed={archived}
          onClick={() => {
            setArchived(true)
            setError('')
          }}
        >
          Archived
        </button>
      </div>
      <div className={styles.toolbar}>
        <p aria-live="polite">
          {visible.length} {archived ? 'archived' : 'active'}{' '}
          {visible.length === 1 ? 'goal' : 'goals'}
        </p>
        <div className={styles.typeFilter}>
          <Select<'ALL' | GoalType>
            id="goal-type-filter"
            label="Goal type"
            value={filter}
            options={[{ value: 'ALL', label: 'All goal types' }, ...goalTypes]}
            onChange={setFilter}
          />
        </div>
      </div>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {visible.length ? (
        <div className={styles.grid}>
          {visible.map((goal) => {
            const definition = goalTypes.find((type) => type.value === goal.type)!
            const Icon = definition.icon
            return (
              <Card
                as="article"
                className={styles.goalCard}
                key={goal.id}
                aria-labelledby={`goal-${goal.id}`}
              >
                <div className={styles.cardHeader}>
                  <span className={styles.goalIcon}>
                    <Icon size={20} strokeWidth={2} aria-hidden="true" focusable="false" />
                  </span>
                  <div className={styles.cardTitle}>
                    <h2 id={`goal-${goal.id}`}>{goal.name}</h2>
                    <p>{definition.label}</p>
                  </div>
                  <Badge tone={goal.archived ? 'neutral' : 'success'}>
                    {goal.archived ? 'Archived' : 'Active'}
                  </Badge>
                </div>
                <GoalMetric goal={goal} />
                <div className={styles.metadata}>
                  {(goal.type === 'VOLUME' || goal.type === 'CONSISTENCY') && (
                    <span>Per {goal.measurementWindow.toLowerCase()}</span>
                  )}
                  {goal.targetDate && (
                    <span>
                      <CalendarDays
                        size={16}
                        strokeWidth={2}
                        aria-hidden="true"
                        focusable="false"
                      />
                      {dateLabel(goal.targetDate)}
                    </span>
                  )}
                  <span>
                    <Target size={16} strokeWidth={2} aria-hidden="true" focusable="false" />
                    {goal.surface.charAt(0) + goal.surface.slice(1).toLowerCase()}
                  </span>
                  {goal.elevationGainM && (
                    <span>
                      <Mountain size={16} strokeWidth={2} aria-hidden="true" focusable="false" />
                      {goal.elevationGainM} m gain
                    </span>
                  )}
                </div>
                <footer className={styles.cardActions}>
                  {onDelete && (
                    <Button
                      variant="secondary"
                      size="compact"
                      className={`${styles.textAction} ${styles.deleteAction}`}
                      onClick={() => setDeleting(goal)}
                      disabled={pendingId !== null}
                      aria-label={`Delete ${goal.name}`}
                    >
                      <Trash2 size={16} strokeWidth={2} aria-hidden="true" focusable="false" />
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    size="compact"
                    className={styles.textAction}
                    disabled={pendingId !== null}
                    loading={pendingId === goal.id}
                    onClick={() => void archive(goal)}
                    aria-label={`${goal.archived ? 'Restore' : 'Archive'} ${goal.name}`}
                  >
                    {goal.archived ? 'Restore' : 'Archive'}
                  </Button>
                  <Button
                    variant="secondary"
                    size="compact"
                    className={`${styles.textAction} ${styles.editAction}`}
                    onClick={() => (onEdit ? onEdit(goal.id) : setEditor(goal))}
                    aria-label={`Edit ${goal.name}`}
                  >
                    Edit{' '}
                    <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" focusable="false" />
                  </Button>
                </footer>
              </Card>
            )
          })}
        </div>
      ) : (
        <Card className={styles.empty}>
          <Target size={20} strokeWidth={2} aria-hidden="true" focusable="false" />
          <h2>
            {filter !== 'ALL'
              ? 'No matching goals'
              : archived
                ? 'No archived goals'
                : 'Your next goal starts here'}
          </h2>
          <p>
            {filter !== 'ALL'
              ? 'Choose another goal type to see more goals.'
              : archived
                ? 'Goals you archive will appear here. You can restore them anytime.'
                : 'Create a goal for your next race, a personal best, or a regular running habit.'}
          </p>
          {filter !== 'ALL' ? (
            <Button variant="secondary" onClick={() => setFilter('ALL')}>
              Show all goal types
            </Button>
          ) : (
            !archived && (
              <Button onClick={() => (onCreate ? onCreate() : setEditor('create'))}>
                Create your first goal
              </Button>
            )
          )}
        </Card>
      )}
      {editor && (
        <GoalForm
          initial={editor === 'create' ? undefined : editor}
          onClose={() => setEditor(null)}
          onSave={(fields) => onSave(fields, editor === 'create' ? undefined : editor.id)}
        />
      )}
      {deleting && onDelete && (
        <ConfirmDialog
          open
          title="Delete goal?"
          description={`Permanently delete “${deleting.name}”? This cannot be undone. Goals used by a plan draft can be archived instead.`}
          confirmText="Delete goal"
          variant="destructive"
          pending={pendingId === deleting.id}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            setPendingId(deleting.id)
            try {
              await onDelete(deleting.id)
              setDeleting(null)
            } catch {
              setDeleting(null)
              setError(
                'This goal could not be deleted. If it is used by a plan draft, archive it instead.',
              )
            } finally {
              setPendingId(null)
            }
          }}
        />
      )}
    </section>
  )
}
