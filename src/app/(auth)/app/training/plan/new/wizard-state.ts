import { z } from 'zod'
import { planConstraintsSchema } from '@/lib/plan-constraints'
import { EXCHANGE_LIMITS } from '@/schemas/plan-exchange.v1'
import { exportFormStateSchema } from '../../../goals/[id]/export/plan-export-state'

export const wizardStateSchema = z.object({
  version: z.literal(1),
  goalId: z.string().max(36),
  step: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  setup: z
    .object({
      mode: z.enum(['initial', 'refresh']).optional(),
      goalName: z.string().max(160),
      goalDate: z.string().nullable(),
      draftId: z.uuid(),
      version: z.number().int().nonnegative(),
      constraints: planConstraintsSchema,
      measurementSystem: z.enum(['METRIC', 'IMPERIAL']),
      today: z.string(),
    })
    .optional(),
  exportState: exportFormStateSchema.optional(),
  text: z.string().max(EXCHANGE_LIMITS.responseBytes),
})
export type WizardState = z.infer<typeof wizardStateSchema>
export const emptyWizard: WizardState = { version: 1, goalId: '', step: 1, text: '' }
export const wizardStorageKey = (ownerId: string, planId?: string) =>
  `running-coach:plan-wizard:v1:${ownerId}${planId ? `:refresh:${planId}` : ''}`

export function readWizard(storage: Pick<Storage, 'getItem'>, key: string): WizardState {
  try {
    const text = storage.getItem(key)
    if (!text || text.length > 1_500_000) return { ...emptyWizard }
    const result = wizardStateSchema.safeParse(JSON.parse(text))
    if (!result.success) return { ...emptyWizard }
    const state = result.data
    // Stored work is recoverable input, never a trusted validation or approval result.
    if (!state.setup) state.step = 1
    else if (!state.exportState?.result && state.step === 3) state.step = 2
    return state
  } catch {
    return { ...emptyWizard }
  }
}
