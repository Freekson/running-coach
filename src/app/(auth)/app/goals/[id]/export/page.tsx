import { notFound, redirect } from 'next/navigation'
import { z } from 'zod'
import { getOwnerContext, OwnedResourceNotFoundError } from '@/server/authorization/ownership'
import { getEditableGoal, GoalReadOnlyError } from '@/server/goals/goals'
import { getAppUser } from '../../../access'
import { AccountUnavailable } from '../../../account-unavailable'
import { PlanExportRoute } from './plan-export-route'

export default async function PlanExportPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getAppUser()
  if (!user) return <AccountUnavailable />
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  let goal
  try {
    goal = await getEditableGoal(getOwnerContext(user), id)
  } catch (error) {
    if (error instanceof OwnedResourceNotFoundError) notFound()
    if (error instanceof GoalReadOnlyError) redirect('/app/goals')
    throw error
  }
  return <PlanExportRoute key={id} goalId={id} goalName={goal.name} />
}
