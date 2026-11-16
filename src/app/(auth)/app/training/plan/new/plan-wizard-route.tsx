'use client'

import { PlanWizard } from './plan-wizard'
import type { GoalRecord } from '@/lib/goals'
import { saveGoalAction } from '../../../goals/actions'
import { goalInput } from '../../../goals/goal-view'
import {
  previewPlanExportAction,
  saveExportScheduleAction,
} from '../../../goals/[id]/export/actions'
import { previewPlanImportAction } from '../../../goals/[id]/import/actions'
import { openWizardDraftAction, approveWizardPlanAction } from './actions'

export function PlanWizardRoute(props: { ownerId: string; goals: GoalRecord[] }) {
  return (
    <PlanWizard
      {...props}
      onOpen={openWizardDraftAction}
      onExport={previewPlanExportAction}
      onSchedule={saveExportScheduleAction}
      onPreview={previewPlanImportAction}
      onApprove={approveWizardPlanAction}
      onCreateGoal={async (fields) => {
        const result = await saveGoalAction(goalInput(fields))
        if (!result.success) throw new Error(result.error)
        return result.value
      }}
    />
  )
}
