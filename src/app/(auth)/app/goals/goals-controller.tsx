'use client'

import { startTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { GoalRecord } from '@/lib/goals'
import { GoalForm } from './goal-form'
import { goalInput, goalView, type GoalFields } from './goal-view'
import { GoalsScreen } from './goals-screen'
import {
  archiveGoalAction,
  deleteGoalAction,
  saveGoalAction,
  type GoalActionResult,
} from './actions'

export function GoalsController({
  goals,
  editor,
}: {
  goals: GoalRecord[]
  editor?: GoalRecord | 'create'
}) {
  const router = useRouter()
  function mutate(action: () => Promise<GoalActionResult>): Promise<void> {
    return new Promise((resolve, reject) => {
      startTransition(async () => {
        try {
          const result = await action()
          if (!result.success) throw new Error(result.error)
          router.refresh()
          resolve()
        } catch (error) {
          reject(error)
        }
      })
    })
  }
  const save = (fields: GoalFields, id?: string) =>
    mutate(() => saveGoalAction(goalInput(fields), id))
  return (
    <>
      <GoalsScreen
        goals={goals.map(goalView)}
        onSave={save}
        onArchive={(id, archived) => mutate(() => archiveGoalAction(id, archived))}
        onDelete={(id) => mutate(() => deleteGoalAction(id))}
        onCreate={() => router.push('/app/goals/new')}
        onEdit={(id) => router.push(`/app/goals/${id}/edit`)}
      />
      {editor && (
        <GoalForm
          key={editor === 'create' ? 'create' : editor.id}
          initial={editor === 'create' ? undefined : goalView(editor)}
          onClose={() => router.push('/app/goals')}
          onSave={(fields) => save(fields, editor === 'create' ? undefined : editor.id)}
        />
      )}
    </>
  )
}
