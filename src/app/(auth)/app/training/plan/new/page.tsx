import { ButtonLink } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { getMeasurementSystem } from '@/server/athlete/profile'
import { getOwnerContext } from '@/server/authorization/ownership'
import { listGoals } from '@/server/goals/goals'
import { AccountUnavailable } from '../../../account-unavailable'
import { getAppUser } from '../../../access'
import { AppShell } from '../../../app-shell'
import { PlanWizardRoute } from './plan-wizard-route'

export default async function NewPlanPage() {
  const user = await getAppUser()
  if (!user) return <AccountUnavailable />
  const owner = getOwnerContext(user)
  const [goals, measurement] = await Promise.allSettled([
    listGoals(owner),
    getMeasurementSystem(owner),
  ])
  return (
    <AppShell
      user={user}
      measurementSystem={measurement.status === 'fulfilled' ? measurement.value : 'METRIC'}
    >
      {goals.status === 'fulfilled' ? (
        <PlanWizardRoute ownerId={user.id} goals={goals.value.filter((goal) => !goal.archived)} />
      ) : (
        <main>
          <Card>
            <h1>Plan creation unavailable</h1>
            <p>Your goals could not be loaded. Your drafts and approved plans are preserved.</p>
            <ButtonLink href="/app/training/plan/new">Try again</ButtonLink>
          </Card>
        </main>
      )}
    </AppShell>
  )
}
