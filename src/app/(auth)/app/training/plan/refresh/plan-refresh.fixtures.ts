import requestJson from '@/../docs/fixtures/plan-exchange-v1/refresh.request.json'
import responseJson from '@/../docs/fixtures/plan-exchange-v1/refresh.response.json'
import type { ApprovedPlanChoice } from '@/lib/plan-refresh'
import type { PlanImportResult } from '@/lib/plan-import'
import { exchangeRequestSchema, exchangeResponseSchema } from '@/schemas/plan-exchange.v1'
import { wizardGoal, wizardPreview, wizardSaved } from '../new/plan-wizard.fixtures'

const request = exchangeRequestSchema.parse(requestJson)
const response = exchangeResponseSchema.parse(responseJson)
if (request.mode !== 'refresh' || response.mode !== 'refresh')
  throw new Error('Expected refresh fixtures')
const [cancel, locked] = request.currentApprovedRevision.workouts
const created = response.operations.find((entry) => entry.operation === 'create')
if (!created || created.operation !== 'create') throw new Error('Expected a created workout')
const before = {
  workoutId: cancel.workoutId,
  scheduledDate: cancel.scheduledDate,
  definition: cancel.definition,
  cancelled: false,
  timezone: cancel.timezone,
}
const unchanged = {
  workoutId: locked.workoutId,
  scheduledDate: locked.scheduledDate,
  definition: locked.definition,
  cancelled: false,
  timezone: locked.timezone,
}
const added = {
  workoutId: created.workoutId,
  scheduledDate: created.scheduledDate,
  definition: created.definition,
  cancelled: false,
  timezone: request.timezone,
}
export const refreshChoice: ApprovedPlanChoice = {
  id: request.currentApprovedRevision.planId,
  goalId: wizardGoal.id,
  goalName: wizardGoal.name,
  revisionId: request.currentApprovedRevision.revisionId,
  revisionNumber: 1,
}
export const refreshSaved = {
  ...wizardSaved,
  text: JSON.stringify(response),
  exportState: {
    ...wizardSaved.exportState!,
    result: {
      requestId: request.requestId,
      json: JSON.stringify({ request }),
      prompt: 'Synthetic manual refresh request',
      bytes: JSON.stringify(request).length,
    },
  },
}
export const refreshPreview: Extract<PlanImportResult, { valid: true }> = {
  ...wizardPreview,
  preview: {
    ...wizardPreview.preview,
    response,
    baseRevisionId: request.currentApprovedRevision.revisionId,
    refresh: {
      macroPlan: request.currentApprovedRevision.macroPlan,
      changes: [
        {
          workoutId: before.workoutId,
          kind: 'canceled',
          before,
          after: { ...before, cancelled: true },
        },
        { workoutId: unchanged.workoutId, kind: 'unchanged', before: unchanged, after: unchanged },
        { workoutId: added.workoutId, kind: 'created', before: null, after: added },
      ],
      schedule: [{ ...before, cancelled: true }, unchanged, added],
      retainedOutsideWindow: 1,
    },
  },
}
