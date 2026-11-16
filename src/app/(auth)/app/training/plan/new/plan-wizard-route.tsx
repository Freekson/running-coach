'use client'

import { PlanWizard } from './plan-wizard'
import type { GoalRecord } from '@/lib/goals'
import type { ApprovedPlanChoice } from '@/lib/plan-refresh'
import { saveGoalAction } from '../../../goals/actions'
import { goalInput } from '../../../goals/goal-view'
import {
  previewPlanExportAction,
  saveExportScheduleAction,
} from '../../../goals/[id]/export/actions'
import { previewPlanImportAction } from '../../../goals/[id]/import/actions'
import {
  openWizardDraftAction,
  openRefreshDraftAction,
  approveWizardPlanAction,
  previewRevisionPublicationAction,
  sendRevisionPublicationAction,
} from './actions'

export function PlanWizardRoute(props: {
  ownerId: string
  goals: GoalRecord[]
  refresh?: ApprovedPlanChoice
}) {
  return (
    <PlanWizard
      {...props}
      onOpen={
        props.refresh
          ? ({ goalId }) =>
              openRefreshDraftAction({
                goalId,
                planId: props.refresh!.id,
                expectedRevisionId: props.refresh!.revisionId,
              })
          : openWizardDraftAction
      }
      onExport={previewPlanExportAction}
      onSchedule={saveExportScheduleAction}
      onPreview={previewPlanImportAction}
      onApprove={approveWizardPlanAction}
      publication={{
        onPreview: previewRevisionPublicationAction,
        onSend: sendRevisionPublicationAction,
      }}
      onCreateGoal={async (fields) => {
        const result = await saveGoalAction(goalInput(fields))
        if (!result.success) throw new Error(result.error)
        return result.value
      }}
    />
  )
}
