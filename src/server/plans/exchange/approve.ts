import 'server-only'

import { z } from 'zod'
import { planImportCommandSchema } from '@/lib/plan-import'
import { planContentSchema } from '@/schemas/plan-content.v1'
import { ownerId, ownedWhere, type OwnerContext } from '@/server/authorization/ownership'
import { approvePlanDraft } from '../revisions'
import { planTransaction, requireDraft, PlanConflictError, PlanStateError } from '../transaction'
import { previewPlanImport } from './import'

const approvalSchema = planImportCommandSchema.extend({ approve: z.literal(true) })

/** Revalidate the original response and commit local approval in one serializable view. */
export async function approvePlanImport(owner: OwnerContext, command: unknown, text: string) {
  ownerId(owner)
  const { approve, ...input } = approvalSchema.parse(command)
  return planTransaction(async (tx) => {
    const result = await previewPlanImport(owner, input, text, tx)
    if (!result.valid) return { approved: false as const, validation: result }
    const { response, review } = result.preview
    // Refresh/diff approval belongs to RUN-38. Never apply a partial refresh as a replacement.
    if (response.mode !== 'initial') throw new PlanStateError()
    if (!review.readyForExplicitApproval) return { approved: false as const, validation: result }
    const draft = await requireDraft(tx, owner, input.draftId)
    if (draft.planId || draft.baseRevisionId) throw new PlanConflictError()
    const goal = await tx.goal.findFirstOrThrow({
      where: ownedWhere(owner, { id: input.goalId, archived: false }),
      select: { updatedAt: true },
    })
    const content = planContentSchema.parse({
      schemaVersion: 1,
      macroPlan: response.macroPlan,
      detailWindow: response.detailWindow,
      workouts: response.workouts,
    })
    const validated = await tx.planDraft.update({
      where: { id: draft.id, userId: owner.userId, version: result.preview.draftVersion },
      data: {
        content,
        state: 'VALIDATED',
        validatedGoalUpdatedAt: goal.updatedAt,
        version: { increment: 1 },
      },
    })
    const revision = await approvePlanDraft(
      owner,
      {
        draftId: draft.id,
        expectedVersion: validated.version,
        expectedRevisionId: null,
        approve,
      },
      tx,
    )
    return {
      approved: true as const,
      planId: revision.planId,
      revisionId: revision.id,
      revisionNumber: revision.revisionNumber,
    }
  })
}
