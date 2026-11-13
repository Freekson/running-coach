import { z } from 'zod'
import { notFound } from 'next/navigation'
import { getActivityDetail } from '@/server/activity/detail'
import { getMeasurementSystem } from '@/server/athlete/profile'
import { getOwnerContext } from '@/server/authorization/ownership'
import { activityDetailBackLink } from '@/lib/activity-detail'
import { getAppUser } from '../../access'
import { AccountUnavailable } from '../../account-unavailable'
import { AppShell } from '../../app-shell'
import { ActivityDetailView } from './activity-detail'

export default async function ActivityDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await getAppUser()
  if (!user) return <AccountUnavailable />
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const owner = getOwnerContext(user)
  const [activity, system] = await Promise.all([
    getActivityDetail(owner, id),
    getMeasurementSystem(owner),
  ])
  if (!activity) notFound()
  const query = await searchParams
  return (
    <AppShell user={user} measurementSystem={system}>
      <ActivityDetailView
        key={`${user.id}:${activity.id}`}
        activity={activity}
        backHref={activityDetailBackLink(query?.back)}
      />
    </AppShell>
  )
}
