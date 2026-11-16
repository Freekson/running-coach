import { z } from 'zod'
import { notFound } from 'next/navigation'
import { getOwnerContext, OwnedResourceNotFoundError } from '@/server/authorization/ownership'
import { getActivityMatching } from '@/server/activity/matching'
import { getMeasurementSystem } from '@/server/athlete/profile'
import { matchingQuerySchema } from '@/lib/activity-matching'
import { getAppUser } from '../../../access'
import { AccountUnavailable } from '../../../account-unavailable'
import { AppShell } from '../../../app-shell'
import { MatchingController } from './matching-controller'

export default async function ActivityMatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await getAppUser()
  if (!user) return <AccountUnavailable />
  const { id } = await params
  const query = await searchParams
  if (!z.uuid().safeParse(id).success) notFound()
  const date = matchingQuerySchema.shape.date.safeParse(query.date).data
  const owner = getOwnerContext(user)
  let data
  try {
    data = await getActivityMatching(owner, { activityId: id, date })
  } catch (error) {
    if (error instanceof OwnedResourceNotFoundError) notFound()
    throw error
  }
  return (
    <AppShell user={user} measurementSystem={await getMeasurementSystem(owner)}>
      <MatchingController
        key={`${id}:${data.searchDate}:${data.linked?.workoutId ?? ''}:${data.linked?.comparison?.revisionId ?? ''}`}
        data={data}
      />
    </AppShell>
  )
}
