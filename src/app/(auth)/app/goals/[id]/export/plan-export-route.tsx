'use client'

import { PlanExportScreen } from './plan-export'
import { openPlanExportAction, previewPlanExportAction, saveExportScheduleAction } from './actions'

export function PlanExportRoute(props: { goalId: string; goalName: string }) {
  return (
    <PlanExportScreen
      {...props}
      onOpen={openPlanExportAction}
      onPreview={previewPlanExportAction}
      onSchedule={saveExportScheduleAction}
    />
  )
}
