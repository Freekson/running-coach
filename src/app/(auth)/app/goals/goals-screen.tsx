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
import {
  dateLabel,
  deadlineLabel,
  goalStatus,
  GoalProgressContent,
  statusLabels,
} from './goal-progress'
import styles from './goals.module.scss'

type GoalsScreenProps = {
  goals: readonly GoalView[]
  onSave: (fields: GoalFields, id?: string) => Promise<void>
  onArchive: (id: string, archived: boolean) => Promise<void>
  initialDialog?: 'create'
  initialEditor?: GoalView | 'create'
  onEditorClose?: () => void
  onDelete?: (id: string) => Promise<void>
  onCreate?: () => void
  onEdit?: (id: string) => void
}

const tabs = ['Active', 'Achieved', 'Archived'] as const

export function GoalsScreen({
  goals,
  onSave,
  onArchive,
  initialDialog,
  initialEditor,
  onEditorClose,
  onDelete,
  onCreate,
  onEdit,
}: GoalsScreenProps) {
  const [tab, setTab] = useState<(typeof tabs)[number]>('Active')
  const [filter, setFilter] = useState<'ALL' | GoalType>('ALL')
  const [editor, setEditor] = useState<GoalView | 'create' | null>(
    initialEditor ?? initialDialog ?? null,
  )
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState<GoalView | null>(null)
  const inTab = goals.filter((goal) => {
    const status = goalStatus(goal)
    return tab === 'Active'
      ? status === 'ACTIVE' || status === 'OVERDUE'
      : status === tab.toUpperCase()
  })
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
      <div className={styles.tabs} role="tablist" aria-label="Goal status">
        {tabs.map((label, index) => (
          <button
            key={label}
            id={`goal-tab-${label}`}
            type="button"
            role="tab"
            aria-selected={tab === label}
            aria-controls="goal-status-panel"
            tabIndex={tab === label ? 0 : -1}
            onClick={() => {
              setTab(label)
              setError('')
            }}
            onKeyDown={(event) => {
              const next =
                event.key === 'ArrowRight'
                  ? (index + 1) % tabs.length
                  : event.key === 'ArrowLeft'
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? tabs.length - 1
                        : null
              if (next === null) return
              event.preventDefault()
              const button = event.currentTarget.parentElement?.querySelectorAll('button')[next]
              button?.focus()
              button?.click()
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="goal-status-panel" aria-labelledby={`goal-tab-${tab}`} tabIndex={0}>
        <div className={styles.toolbar}>
          <p aria-live="polite">
            {visible.length} {tab.toLowerCase()} {visible.length === 1 ? 'goal' : 'goals'}
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
              const status = goalStatus(goal)
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
                      <p>{definition.label} goal</p>
                    </div>
                    <Badge
                      tone={
                        status === 'OVERDUE'
                          ? 'warning'
                          : status === 'ARCHIVED'
                            ? 'neutral'
                            : status === 'ACHIEVED'
                              ? 'success'
                              : 'info'
                      }
                    >
                      {statusLabels[status]}
                    </Badge>
                  </div>
                  <GoalProgressContent goal={goal} />
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
                        {goal.progress?.daysRemaining !== null &&
                          goal.progress?.daysRemaining !== undefined && (
                            <> · {deadlineLabel(goal.progress.daysRemaining)}</>
                          )}
                      </span>
                    )}
                    {(goal.type === 'PERFORMANCE' || goal.type === 'COMPLETION') && (
                      <span>{goal.distanceKm} km</span>
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
                      disabled={pendingId !== null || goal.archived || goal.progress?.achieved}
                      title={
                        goal.archived || goal.progress?.achieved
                          ? 'This goal is read-only'
                          : undefined
                      }
                      onClick={() => (onEdit ? onEdit(goal.id) : setEditor(goal))}
                      aria-label={`Edit ${goal.name}`}
                    >
                      Edit{' '}
                      <ArrowUpRight
                        size={16}
                        strokeWidth={2}
                        aria-hidden="true"
                        focusable="false"
                      />
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
                : tab === 'Archived'
                  ? 'No archived goals'
                  : tab === 'Achieved'
                    ? 'No achieved goals yet'
                    : 'Your next goal starts here'}
            </h2>
            <p>
              {filter !== 'ALL'
                ? 'Choose another goal type to see more goals.'
                : tab === 'Archived'
                  ? 'Goals you archive will appear here. You can restore them anytime.'
                  : tab === 'Achieved'
                    ? 'Goals appear here when qualifying activities meet their targets.'
                    : 'Create a goal for your next race, a personal best, or a regular running habit.'}
            </p>
            {filter !== 'ALL' ? (
              <Button variant="secondary" onClick={() => setFilter('ALL')}>
                Show all goal types
              </Button>
            ) : (
              tab === 'Active' && (
                <Button onClick={() => (onCreate ? onCreate() : setEditor('create'))}>
                  Create your first goal
                </Button>
              )
            )}
          </Card>
        )}
      </div>
      {editor && (
        <GoalForm
          initial={editor === 'create' ? undefined : editor}
          onClose={() => {
            setEditor(null)
            onEditorClose?.()
          }}
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
