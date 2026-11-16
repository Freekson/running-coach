import packet from '@/../docs/fixtures/plan-exchange-v1/initial.package.json'
import responseJson from '@/../docs/fixtures/plan-exchange-v1/initial.response.json'
import type { GoalRecord } from '@/lib/goals'
import { defaultExportConsent, type ExportSetup } from '@/lib/plan-export'
import type { PlanImportResult } from '@/lib/plan-import'
import { estimateWorkout } from '@/lib/workout-estimate'
import { exchangeRequestSchema, exchangeResponseSchema } from '@/schemas/plan-exchange.v1'
import type { WizardState } from './wizard-state'

const request = exchangeRequestSchema.parse(packet.request)
const response = exchangeResponseSchema.parse(responseJson)
export const wizardOwner = '00000000-0000-4000-8000-000000000900'
export const wizardGoal: GoalRecord = {
  ...request.goal,
  id: '00000000-0000-4000-8000-000000000102',
  archived: false,
}
export const wizardSetup: ExportSetup = {
  goalName: wizardGoal.name,
  goalDate: wizardGoal.targetDate,
  draftId: request.draft.draftId,
  version: 0,
  constraints: request.draft.constraints,
  measurementSystem: 'METRIC',
  today: '2026-11-15',
}
export const wizardArtifact = {
  requestId: request.requestId,
  json: JSON.stringify(packet),
  prompt: `Follow this request package and return JSON: ${JSON.stringify(packet)}`,
  bytes: JSON.stringify(packet).length,
}
export const wizardSaved: WizardState = {
  version: 1,
  goalId: wizardGoal.id,
  step: 2,
  setup: wizardSetup,
  text: JSON.stringify(response),
  exportState: {
    constraints: wizardSetup.constraints,
    consent: defaultExportConsent,
    background: { experience: 'unknown', firstWorkoutEver: null },
    start: request.allowedDetailWindow.startDate,
    length: '28',
    result: wizardArtifact,
    race: { date: '', distance: '', seconds: '', kind: 'race' },
  },
}
export const wizardPreview: Extract<PlanImportResult, { valid: true }> = {
  valid: true,
  errors: [],
  repairPrompt: null,
  preview: {
    requestId: request.requestId,
    draftVersion: 0,
    baseRevisionId: null,
    response,
    methodVersion: 'recorded-load-v1',
    weeks: [],
    sessions:
      response.mode === 'initial'
        ? response.workouts.map((w, i) => ({
            workoutId: w.workoutId,
            scheduledDate: w.scheduledDate,
            path: ['workouts', i],
            estimate: estimateWorkout(w.definition),
            intervalSeconds: 0,
            intervalMeters: 0,
          }))
        : [],
    warnings: [
      {
        id: 'abcdef012345abcdef012345',
        severity: 'warning',
        code: 'limited_history',
        confidence: 'low',
        path: [],
        workoutIds: [],
        message: 'Recorded history is incomplete. Review the proposed training load.',
        evidence: { proposed: 1, observed: null, unit: 'sessions', window: response.detailWindow },
      },
    ],
    review: {
      acknowledgedWarningIds: [],
      unacknowledgedWarningIds: ['abcdef012345abcdef012345'],
      warningRationale: null,
      readyForExplicitApproval: false,
      requiresExplicitApproval: true,
      approved: false,
      published: false,
    },
  },
}
