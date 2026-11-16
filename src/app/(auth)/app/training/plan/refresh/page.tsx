import { ButtonLink } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/States'
import { getMeasurementSystem } from '@/server/athlete/profile'
import { getOwnerContext } from '@/server/authorization/ownership'
import { listGoals } from '@/server/goals/goals'
import { listApprovedPlans } from '@/server/plans/refresh'
import { AccountUnavailable } from '../../../account-unavailable'
import { getAppUser } from '../../../access'
import { AppShell } from '../../../app-shell'
import { PlanWizardRoute } from '../new/plan-wizard-route'
import styles from '../new/plan-wizard.module.scss'

export default async function RefreshPlanPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await getAppUser()
  if (!user) return <AccountUnavailable />
  const owner = getOwnerContext(user)
  const [plans, goals, measurement] = await Promise.allSettled([
    listApprovedPlans(owner),
    listGoals(owner),
    getMeasurementSystem(owner),
  ])
  const planId = (await searchParams).planId
  const selected =
    plans.status === 'fulfilled' ? plans.value.find((plan) => plan.id === planId) : undefined
  const selectedGoal =
    goals.status === 'fulfilled'
      ? goals.value.find((goal) => goal.id === selected?.goalId && !goal.archived)
      : undefined
  return (
    <AppShell
      user={user}
      measurementSystem={measurement.status === 'fulfilled' ? measurement.value : 'METRIC'}
    >
      {selected && selectedGoal ? (
        <PlanWizardRoute ownerId={user.id} goals={[selectedGoal]} refresh={selected} />
      ) : (
        <main className={styles.screen}>
          <h1>Refresh an approved plan</h1>
          <p>
            Choose a plan to update its next 2–4 weeks. Goals, constraints, macro strategy and
            previous revisions are preserved.
          </p>
          {plans.status !== 'fulfilled' || goals.status !== 'fulfilled' ? (
            <Card>
              <p role="alert">
                Approved plans could not be loaded. Your saved revisions are preserved.
              </p>
              <ButtonLink href="/app/training/plan/refresh">Try again</ButtonLink>
            </Card>
          ) : (
            <>
              {planId && (
                <p role="alert">
                  The selected plan is unavailable. Select one of your current approved plans.
                </p>
              )}
              {!plans.value.length && (
                <EmptyState
                  title="No approved plans yet"
                  description="Create and approve a training plan before refreshing its detail."
                  action={
                    <ButtonLink href="/app/training/plan/new">Create training plan</ButtonLink>
                  }
                />
              )}
              {plans.value.map((plan) => (
                <Card key={plan.id} className={styles.stack}>
                  <h2>{plan.goalName}</h2>
                  <p>
                    Current revision {plan.revisionNumber} · Plan {plan.id}
                  </p>
                  <ButtonLink href={`/app/training/plan/refresh?planId=${plan.id}`}>
                    Refresh this plan
                  </ButtonLink>
                  <ButtonLink href={`/app/training/plan/${plan.id}`} variant="secondary">
                    Inspect saved revisions
                  </ButtonLink>
                </Card>
              ))}
            </>
          )}
          <ButtonLink href="/app/training" variant="secondary">
            Back to Training
          </ButtonLink>
        </main>
      )}
    </AppShell>
  )
}
