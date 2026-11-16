import 'server-only'

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { goalInputSchema } from '@/lib/goals'
import { healthLocalDay } from '@/lib/health-history'
import { normalizeMeasurementSystem } from '@/lib/measurement-system'
import { planConstraintDefaults, planConstraintsSchema } from '@/lib/plan-constraints'
import {
  exportSelectionSchema,
  openExportSchema,
  type ExportArtifact,
  type ExportSetup,
} from '@/lib/plan-export'
import {
  exchangeRequestSchema,
  EXCHANGE_LIMITS,
  type ExchangeRequest,
} from '@/schemas/plan-exchange.v1'
import { athleteReportSchema } from '@/schemas/training-context.v1'
import { macroPlanSchema } from '@/schemas/plan-content.v1'
import {
  ownedWhere,
  ownerId,
  OwnedResourceNotFoundError,
  type OwnerContext,
} from '@/server/authorization/ownership'
import { constraintsFromDraft } from '../content'
import {
  planTransaction,
  requireDraft,
  requireDraftVersion,
  PlanConflictError,
  PlanStateError,
  RefreshWindowError,
} from '../transaction'
import { buildTrainingEvidence, readTrainingEvidence } from './evidence'
import { createPlanExchangePackage } from './package'
import { readStoredActivityCoverage, readStoredRecovery } from './stored-context'
import {
  assertRefreshGoalHorizon,
  projectCommitment,
  projectMacroPlan,
  selectRefreshCommitments,
} from './refresh-context'

export async function openPlanExport(
  owner: OwnerContext,
  input: unknown,
  options?: { initialOnly: true } | { planId: string; expectedRevisionId: string },
): Promise<ExportSetup> {
  const userId = ownerId(owner)
  const { goalId } = openExportSchema.parse(input)
  return planTransaction(async (tx) => {
    const goal = await tx.goal.findFirst({
      where: ownedWhere(owner, { id: goalId, archived: false }),
    })
    if (!goal) throw new OwnedResourceNotFoundError()
    const profile = await tx.athleteProfile.findUnique({ where: { userId } })
    const initialOnly = options && 'initialOnly' in options
    const selected = options && 'planId' in options ? options : null
    const plan = initialOnly
      ? null
      : await tx.trainingPlan.findFirst({
          where: ownedWhere(owner, { goalId, ...(selected ? { id: selected.planId } : {}) }),
          orderBy: { updatedAt: 'desc' },
        })
    const base = plan?.currentRevisionId
      ? await tx.planRevision.findFirst({
          where: ownedWhere(owner, { id: plan.currentRevisionId, planId: plan.id, goalId }),
        })
      : null
    if (selected && (!plan || !base)) throw new OwnedResourceNotFoundError()
    if (selected && base?.id !== selected.expectedRevisionId) throw new PlanConflictError()
    if (base)
      assertRefreshGoalHorizon(
        z.object({ macroPlan: z.unknown() }).parse(base.snapshot).macroPlan,
        goal.targetDate?.toISOString().slice(0, 10) ?? null,
      )
    let draft = await tx.planDraft.findFirst({
      where: ownedWhere(owner, {
        goalId,
        state: { not: 'APPROVED' },
        baseRevisionId: base?.id ?? null,
        ...(initialOnly ? { planId: null } : {}),
      }),
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    })
    if (base && draft) {
      const saved = planConstraintsSchema.parse(
        z.object({ constraints: z.unknown() }).parse(base.snapshot).constraints,
      )
      if (JSON.stringify(saved) !== JSON.stringify(constraintsFromDraft(draft))) draft = null
    }
    if (!draft) {
      const constraints = base
        ? planConstraintsSchema.parse(
            z.object({ constraints: z.unknown() }).parse(base.snapshot).constraints,
          )
        : planConstraintDefaults(profile)
      draft = await tx.planDraft.create({
        data: {
          userId,
          goalId,
          planId: base ? plan!.id : null,
          baseRevisionId: base?.id ?? null,
          ...constraints,
          startDate: constraints.startDate ? new Date(constraints.startDate) : null,
        },
      })
    }
    return {
      mode: base ? 'refresh' : 'initial',
      goalName: goal.name,
      goalDate: goal.targetDate?.toISOString().slice(0, 10) ?? null,
      draftId: draft.id,
      version: draft.version,
      constraints: constraintsFromDraft(draft),
      measurementSystem: normalizeMeasurementSystem(profile?.measurementSystem),
      today: healthLocalDay(new Date().toISOString(), draft.timezone),
    }
  })
}

/** All source reads and the issued snapshot share a serializable database view. No provider adapters. */
export async function issuePlanExport(
  owner: OwnerContext,
  input: unknown,
): Promise<ExportArtifact> {
  const userId = ownerId(owner)
  const selection = exportSelectionSchema.parse(input)
  return planTransaction(async (tx) => {
    const now = new Date()
    const draft = await requireDraft(tx, owner, selection.draftId)
    requireDraftVersion(draft, selection.expectedVersion)
    const goal = await tx.goal.findFirst({
      where: ownedWhere(owner, { id: draft.goalId, archived: false }),
    })
    if (!goal) throw new OwnedResourceNotFoundError()
    const constraints = constraintsFromDraft(draft)
    const timezone = constraints.timezone
    const today = healthLocalDay(now.toISOString(), timezone)
    const window = selection.allowedDetailWindow
    if (
      !draft.baseRevisionId &&
      ((constraints.startDate && window.startDate < constraints.startDate) ||
        (goal.targetDate && window.endDate > goal.targetDate.toISOString().slice(0, 10)))
    )
      throw new PlanStateError()
    const consent = {
      ...selection.consent,
      activityHeartRate:
        selection.consent.recordedActivityMetrics && selection.consent.activityHeartRate,
      recordedLaps: selection.consent.recordedActivityMetrics && selection.consent.recordedLaps,
      limitationsOrFatigue:
        selection.consent.athleteReport && selection.consent.limitationsOrFatigue,
    }
    const coverage = await readStoredActivityCoverage(tx, owner, timezone, now)
    const evidenceOptions = {
      timezone,
      now,
      coverage,
      includeHeartRate: consent.activityHeartRate,
      includeLaps: consent.recordedLaps,
    }
    const evidence = consent.recordedActivityMetrics
      ? await readTrainingEvidence(owner, evidenceOptions, tx)
      : buildTrainingEvidence(owner, [], {
          ...evidenceOptions,
          coverage: { ...coverage, status: 'unknown', completeWindows: [] },
        })
    // Coverage stays inspectable even when observations are withheld. Totals remain null.
    if (!consent.recordedActivityMetrics) evidence.activityHistoryCoverage = coverage
    const provenance = {
      source: 'ATHLETE' as const,
      quality: 'reported' as const,
      observedAt: now.toISOString(),
      period: { startDate: today, endDate: today },
    }
    const background = consent.athleteReport ? selection.background : undefined
    const report = background
      ? athleteReportSchema.parse({
          experience: background.experience,
          firstWorkoutEver: background.firstWorkoutEver,
          provenance,
          ...Object.fromEntries(
            (
              [
                'previousExperience',
                'easyEffort',
                'crossTraining',
                'preferredWorkoutTypes',
                'limitationsOrFatigue',
              ] as const
            )
              .filter(
                (key) =>
                  background[key] &&
                  (key !== 'limitationsOrFatigue' || consent.limitationsOrFatigue),
              )
              .map((key) => [key, { value: background[key], provenance }]),
          ),
          ...(background.raceOrTestResults
            ? { raceOrTestResults: background.raceOrTestResults.map((r) => ({ ...r, provenance })) }
            : {}),
        })
      : undefined
    if (background?.raceOrTestResults?.some((r) => r.date > today)) throw new PlanStateError()
    const profile = await tx.athleteProfile.findUnique({
      where: { userId },
      select: { measurementSystem: true },
    })
    const priorPlans = await tx.planRevision.count({ where: ownedWhere(owner, {}) })
    const common = {
      schemaVersion: 1,
      requestId: randomUUID(),
      generatedAt: now.toISOString(),
      athleteLocalDate: today,
      timezone,
      measurementSystem: normalizeMeasurementSystem(profile?.measurementSystem),
      goal: goalInputSchema.parse({
        name: goal.name,
        type: goal.type,
        distanceMeters: goal.distanceMeters?.toNumber() ?? null,
        targetTimeSeconds: goal.targetTimeSeconds,
        targetCount: goal.targetCount,
        measurementWindow: goal.measurementWindow,
        targetDate: goal.targetDate?.toISOString().slice(0, 10) ?? null,
        surface: goal.surface,
        elevationGainM: goal.elevationGainM,
      }),
      draft: { draftId: draft.id, version: draft.version, constraints },
      allowedDetailWindow: window,
      lockedDates: [] as string[],
      consent,
      trainingContext: {
        ...evidence,
        schemaVersion: 1,
        lifecycle: {
          firstPlanForAthlete: priorPlans === 0,
          firstWorkoutInPlan: draft.baseRevisionId === null,
        },
        ...(report ? { athleteReport: report } : {}),
        ...(consent.recovery
          ? { recoveryContext: await readStoredRecovery(tx, owner, timezone, now) }
          : {}),
      },
    }
    let request: ExchangeRequest
    if (draft.baseRevisionId && draft.planId) {
      const plan = await tx.trainingPlan.findFirst({
        where: ownedWhere(owner, { id: draft.planId, goalId: draft.goalId }),
      })
      if (!plan || plan.currentRevisionId !== draft.baseRevisionId) throw new PlanConflictError()
      const base = await tx.planRevision.findFirst({
        where: ownedWhere(owner, { id: draft.baseRevisionId, planId: plan.id, goalId: goal.id }),
      })
      if (!base) throw new OwnedResourceNotFoundError()
      const approvedConstraints = planConstraintsSchema.parse(
        z.object({ constraints: z.unknown() }).parse(base.snapshot).constraints,
      )
      if (JSON.stringify(approvedConstraints) !== JSON.stringify(constraints))
        throw new PlanConflictError()
      const snapshot = z
        .object({ macroPlan: macroPlanSchema, detailWindow: z.unknown() })
        .parse(base.snapshot)
      assertRefreshGoalHorizon(
        snapshot.macroPlan,
        goal.targetDate?.toISOString().slice(0, 10) ?? null,
      )
      if (
        window.startDate < snapshot.macroPlan.startDate ||
        window.endDate > snapshot.macroPlan.endDate
      )
        throw new RefreshWindowError(snapshot.macroPlan.startDate, snapshot.macroPlan.endDate)
      const rows = await tx.planRevisionWorkout.findMany({
        where: ownedWhere(owner, { revisionId: base.id, planId: plan.id }),
        include: { workout: true },
        orderBy: [{ scheduledDate: 'asc' }, { workoutId: 'asc' }],
      })
      const { required, history } = selectRefreshCommitments(rows, window, timezone, now)
      const workouts = required.map((row) =>
        projectCommitment(row, consent.recordedActivityMetrics),
      )
      const lockedDates = [
        ...new Set(
          workouts
            .filter((w) => w.lockedAt || w.completedAt)
            .map((w) => w.scheduledDate)
            .filter((date) => date >= window.startDate && date <= window.endDate),
        ),
      ]
      request = exchangeRequestSchema.parse({
        ...common,
        mode: 'refresh',
        lockedDates,
        trainingContext: {
          ...common.trainingContext,
          lifecycle: { firstPlanForAthlete: false, firstWorkoutInPlan: false },
        },
        currentApprovedRevision: {
          planId: plan.id,
          revisionId: base.id,
          revisionNumber: base.revisionNumber,
          macroPlan: projectMacroPlan(snapshot.macroPlan),
          detailWindow: snapshot.detailWindow,
          workouts,
          commitmentsCoverage: required.length === rows.length ? 'complete' : 'partial',
          omittedHistoricalCommitments: rows.length - required.length,
          narrativePolicy: 'withheld',
        },
        allowedWorkoutIds: workouts
          .filter(
            (w) =>
              !w.cancelled &&
              !w.completedAt &&
              !w.lockedAt &&
              w.scheduledDate > healthLocalDay(now.toISOString(), w.timezone) &&
              w.scheduledDate >= window.startDate &&
              w.scheduledDate <= window.endDate &&
              !lockedDates.includes(w.scheduledDate),
          )
          .map((w) => w.workoutId),
        allowedCreateWorkoutIds: Array.from({ length: 28 }, () => randomUUID()),
      })
      // Required commitments must fit. Add the newest past sessions only while
      // both JSON and prompt fit; omitted history stays unchanged in the database.
      exportArtifact(request)
      for (const row of history) {
        if (request.mode !== 'refresh') throw new PlanStateError()
        const selected = [
          ...request.currentApprovedRevision.workouts,
          projectCommitment(row, consent.recordedActivityMetrics),
        ].sort(
          (a, b) =>
            a.scheduledDate.localeCompare(b.scheduledDate) ||
            a.workoutId.localeCompare(b.workoutId),
        )
        const candidate = exchangeRequestSchema.parse({
          ...request,
          currentApprovedRevision: {
            ...request.currentApprovedRevision,
            workouts: selected,
            commitmentsCoverage: selected.length === rows.length ? 'complete' : 'partial',
            omittedHistoricalCommitments: rows.length - selected.length,
          },
        })
        try {
          exportArtifact(candidate)
        } catch (error) {
          if (
            error instanceof z.ZodError &&
            error.issues.every(
              (issue) =>
                issue.path.length === 0 &&
                ['Request package exceeds byte limit', 'Copy prompt exceeds byte limit'].includes(
                  issue.message,
                ),
            )
          )
            break
          throw error
        }
        request = candidate
      }
    } else request = exchangeRequestSchema.parse({ ...common, mode: 'initial' })
    exportArtifact(request)
    const saved = await tx.planExchangeRequest.create({
      data: {
        id: request.requestId,
        userId,
        goalId: goal.id,
        draftId: draft.id,
        draftVersion: draft.version,
        schemaVersion: request.schemaVersion,
        generatedAt: now,
        snapshot: request,
      },
    })
    // Prisma/PostgreSQL JSON numeric serialization can normalize trailing precision.
    // Build both outputs from the stored representation used by subsequent imports.
    return exportArtifact(saved.snapshot)
  })
}

export function exportArtifact(request: unknown): ExportArtifact {
  const packet = createPlanExchangePackage(request)
  const json = JSON.stringify(packet)
  const prompt = `Follow the instructions in this complete request package and return the requested JSON response:\n${json}`
  if (new TextEncoder().encode(prompt).byteLength > EXCHANGE_LIMITS.requestBytes)
    throw new z.ZodError([{ code: 'custom', path: [], message: 'Copy prompt exceeds byte limit' }])
  return {
    requestId: packet.request.requestId,
    json,
    bytes: new TextEncoder().encode(json).byteLength,
    prompt,
  }
}

/** Downstream import must load this owner-scoped snapshot, then recheck live draft/revision state. */
export async function getIssuedPlanExport(owner: OwnerContext, id: string) {
  ownerId(owner)
  z.uuid().parse(id)
  return planTransaction(async (tx) => {
    const row = await tx.planExchangeRequest.findFirst({ where: ownedWhere(owner, { id }) })
    if (!row) throw new OwnedResourceNotFoundError()
    const latest = await tx.planExchangeRequest.findFirst({
      where: ownedWhere(owner, { draftId: row.draftId }),
      orderBy: { issuanceSequence: 'desc' },
      select: { id: true },
    })
    if (latest?.id !== row.id) throw new PlanConflictError()
    const snapshot = exchangeRequestSchema.parse(row.snapshot)
    // Immutable snapshots issued before narrative filtering must be reissued;
    // reading one must not restore prior consent-bypassing approved-plan text.
    if (
      snapshot.mode === 'refresh' &&
      snapshot.currentApprovedRevision.narrativePolicy !== 'withheld'
    )
      throw new PlanConflictError()
    return snapshot
  })
}
