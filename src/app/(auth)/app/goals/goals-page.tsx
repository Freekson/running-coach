import 'server-only'

import { notFound } from 'next/navigation'
import { z } from 'zod'
import { Card } from '@/components/ui/Card'
import { ButtonLink } from '@/components/ui/Button'
import { getOwnerContext, OwnedResourceNotFoundError } from '@/server/authorization/ownership'
import { listGoals, getGoal } from '@/server/goals/goals'
import { getAppUser } from '../access'
import { AccountUnavailable } from '../account-unavailable'
import { GoalsController } from './goals-controller'
import styles from './goals.module.scss'

export async function renderGoalsPage(editor?: 'create' | { id: string }) {
  const user = await getAppUser()
  if (!user) return <AccountUnavailable />
  const owner = getOwnerContext(user)
  if (typeof editor === 'object' && !z.uuid().safeParse(editor.id).success) notFound()
  let goals, initialEditor
  try {
    ;[goals, initialEditor] = await Promise.all([
      listGoals(owner),
      typeof editor === 'object' ? getGoal(owner, editor.id) : Promise.resolve(editor),
    ])
  } catch (error) {
    if (error instanceof OwnedResourceNotFoundError) notFound()
    return (
      <main className={styles.screen}>
        <h1>Goals</h1>
        <Card>
          <h2>Goals unavailable</h2>
          <p>Please try again. Your saved goals have not changed.</p>
          <ButtonLink href="/app/goals" variant="secondary">
            Try again
          </ButtonLink>
        </Card>
      </main>
    )
  }
  return (
    <main>
      <GoalsController goals={goals} editor={initialEditor} />
    </main>
  )
}
