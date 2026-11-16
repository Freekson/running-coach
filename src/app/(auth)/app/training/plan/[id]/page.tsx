import { z } from 'zod'
import { ButtonLink } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { planContentSchema } from '@/schemas/plan-content.v1'
import { planConstraintsSchema } from '@/lib/plan-constraints'
import { getOwnerContext } from '@/server/authorization/ownership'
import { getMeasurementSystem } from '@/server/athlete/profile'
import { getTrainingPlan, getPlanRevision, listPlanRevisions } from '@/server/plans/revisions'
import { AccountUnavailable } from '../../../account-unavailable'
import { getAppUser } from '../../../access'
import { AppShell } from '../../../app-shell'
import { WorkoutSteps } from '../new/plan-review'
import { RevisionPublicationRoute } from '../revision-publication-route'
import { RevisionSnapshot } from './revision-snapshot'
import styles from '../new/plan-wizard.module.scss'

async function load(owner: ReturnType<typeof getOwnerContext>, id: string, revisionId: unknown) {
  const plan = await getTrainingPlan(owner, id)
  const revisions = await listPlanRevisions(owner, id)
  const selectedId = typeof revisionId === 'string' ? revisionId : plan.currentRevisionId
  if (!selectedId) throw new Error('Approved revision unavailable')
  const revision = await getPlanRevision(owner, id, selectedId)
  const snapshot = planContentSchema
    .omit({ workouts: true })
    .extend({ constraints: planConstraintsSchema, goal: z.json() })
    .parse(revision.snapshot)
  return { plan, revisions, revision, snapshot }
}

export default async function PlanHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await getAppUser()
  if (!user) return <AccountUnavailable />
  const owner = getOwnerContext(user)
  const { id } = await params
  const query = await searchParams
  const [result, measurement] = await Promise.allSettled([
    load(owner, id, query.revisionId),
    getMeasurementSystem(owner),
  ])
  const data = result.status === 'fulfilled' ? result.value : null
  return (
    <AppShell
      user={user}
      measurementSystem={measurement.status === 'fulfilled' ? measurement.value : 'METRIC'}
    >
      <main className={styles.screen}>
        <h1>Saved plan revisions</h1>
        <ButtonLink href="/app/training/plan/refresh" variant="secondary">
          Back to approved plans
        </ButtonLink>
        {!data ? (
          <Card>
            <p role="alert">
              This plan or revision is unavailable. Select one of your own approved plans.
            </p>
          </Card>
        ) : (
          <>
            <Card className={styles.stack}>
              <h2>Revision history</h2>
              <p>
                Each approved version is retained unchanged. Inspect or download a snapshot to
                recover its original schedule. Historical snapshots do not replace the current
                revision.
              </p>
              <nav aria-label="Saved revisions" className={styles.steps}>
                {data.revisions.map((revision) => (
                  <ButtonLink
                    variant="secondary"
                    key={revision.id}
                    href={`/app/training/plan/${id}?revisionId=${revision.id}`}
                    aria-current={revision.id === data.revision.id ? 'page' : undefined}
                  >
                    Revision {revision.revisionNumber}
                    {revision.id === data.plan.currentRevisionId ? ' (current)' : ''}
                  </ButtonLink>
                ))}
              </nav>
            </Card>
            <Card className={styles.stack}>
              <h2>Revision {data.revision.revisionNumber}</h2>
              <p>Approved {data.revision.approvedAt.toISOString()}</p>
              <p>{data.snapshot.macroPlan.strategy}</p>
              <p>
                Detail window: {data.snapshot.detailWindow.startDate} –{' '}
                {data.snapshot.detailWindow.endDate}
              </p>
              <p>
                {data.snapshot.constraints.sessionsPerWeek} sessions per week ·{' '}
                {data.snapshot.constraints.timezone}
              </p>
              <RevisionSnapshot
                revisionNumber={data.revision.revisionNumber}
                json={JSON.stringify(
                  {
                    revisionId: data.revision.id,
                    revisionNumber: data.revision.revisionNumber,
                    ...data.snapshot,
                    workouts: data.revision.workouts.map((w) => ({
                      workoutId: w.workoutId,
                      scheduledDate: w.scheduledDate.toISOString().slice(0, 10),
                      timezone: w.timezone,
                      definition: w.definition,
                      cancelled: w.cancelled,
                    })),
                  },
                  null,
                  2,
                )}
              />
            </Card>
            <Card className={styles.stack}>
              <h2>Saved schedule</h2>
              {data.revision.workouts.map((workout) => {
                const definition = planContentSchema.shape.workouts.element.shape.definition.parse(
                  workout.definition,
                )
                return (
                  <details key={workout.workoutId} className={styles.day}>
                    <summary>
                      {workout.scheduledDate.toISOString().slice(0, 10)} · {workout.timezone} ·{' '}
                      {definition.name}
                      {workout.cancelled ? ' · Canceled' : ''}
                    </summary>
                    <WorkoutSteps nodes={definition.steps} />
                  </details>
                )
              })}
            </Card>
            {data.revision.id === data.plan.currentRevisionId && (
              <RevisionPublicationRoute planId={data.plan.id} revisionId={data.revision.id} />
            )}
          </>
        )}
      </main>
    </AppShell>
  )
}
