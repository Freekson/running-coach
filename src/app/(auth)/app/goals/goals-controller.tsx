'use client'

import { useState } from 'react'
import type { GoalRecord } from '@/lib/goals'
import type { GoalSnapshot } from '@/lib/goal-snapshot'
import { goalInput, goalView, type GoalFields } from './goal-view'
import { GoalsScreen } from './goals-screen'
import {
  acceptGoalMutation,
  acceptGoalSnapshot,
  createGoalState,
  goalStateRecords,
} from './goal-state'
import {
  archiveGoalAction,
  deleteGoalAction,
  saveGoalAction,
  type GoalActionResult,
} from './actions'

export function GoalsController({
  snapshot,
  editor,
}: {
  snapshot: GoalSnapshot
  editor?: GoalRecord | 'create'
}) {
  const [state, setState] = useState(() => createGoalState(snapshot))
  if (state.received !== snapshot) {
    setState(acceptGoalSnapshot(state, snapshot))
  }
  async function mutate<T>(action: () => Promise<GoalActionResult<T>>) {
    const result = await action()
    if (!result.success) throw new Error(result.error)
    return result
  }
  async function save(fields: GoalFields, id?: string) {
    const result = await mutate(() => saveGoalAction(goalInput(fields), id))
    setState((previous) => acceptGoalMutation(previous, result.value.id, result))
  }
  return (
    <GoalsScreen
      key={state.base.ownerId}
      goals={goalStateRecords(state).map(goalView)}
      onSave={save}
      onArchive={async (id, archived) => {
        const result = await mutate(() => archiveGoalAction(id, archived))
        setState((previous) => acceptGoalMutation(previous, id, result))
      }}
      onDelete={async (id) => {
        const result = await mutate(() => deleteGoalAction(id))
        setState((previous) => acceptGoalMutation(previous, id, result))
      }}
      initialEditor={editor === 'create' ? 'create' : editor ? goalView(editor) : undefined}
      onEditorClose={() => {
        if (window.location.pathname !== '/app/goals')
          window.history.replaceState(null, '', '/app/goals')
      }}
    />
  )
}
