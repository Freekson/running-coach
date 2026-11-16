import 'server-only'

import { z } from 'zod'
import { planImportCommandSchema } from '@/lib/plan-import'
import { ownerId, ownedWhere, type OwnerContext } from '@/server/authorization/ownership'
import { approvePlanDraft } from '../revisions'
import { planTransaction, requireDraft, PlanConflictError, PlanStateError } from '../transaction'
import { previewPlanImport } from './import'
import { constraintsFromDraft } from '../content'
import { buildImportProposal } from './proposal'

const approvalSchema = planImportCommandSchema.extend({ approve: z.literal(true) })

/** Revalidate the original response and commit local approval in one serializable view. */
export async function approvePlanImport(owner: OwnerContext, command: unknown, text: string) {
  ownerId(owner)
  const { approve, ...input } = approvalSchema.parse(command)
  return planTransaction(async (tx) => {
    const result = await previewPlanImport(owner, input, text, tx)
    if (!result.valid) return { approved: false as const, validation: result }
    const { response, review } = result.preview
    if (!review.readyForExplicitApproval) return { approved: false as const, validation: result }
    const draft = await requireDraft(tx, owner, input.draftId)
    if (response.mode === 'initial' && (draft.planId || draft.baseRevisionId))
      throw new PlanConflictError()
    if (response.mode === 'refresh' && (!draft.planId || !draft.baseRevisionId))
      throw new PlanStateError()
    const goal = await tx.goal.findFirstOrThrow({
      where: ownedWhere(owner, { id: input.goalId, archived: false }),
      select: { updatedAt: true, targetDate: true },
    })
    const base = draft.baseRevisionId
      ? await tx.planRevision.findFirstOrThrow({
          where: ownedWhere(owner, { id: draft.baseRevisionId, planId: draft.planId! }),
          include: { workouts: { include: { workout: true } } },
        })
      : null
    const { content } = buildImportProposal(
      base?.workouts ?? [],
      response,
      constraintsFromDraft(draft),
      new Date(),
      base ? z.object({ macroPlan: z.unknown() }).parse(base.snapshot).macroPlan : undefined,
      goal.targetDate?.toISOString().slice(0, 10) ?? null,
    )
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
        expectedRevisionId: draft.baseRevisionId,
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
