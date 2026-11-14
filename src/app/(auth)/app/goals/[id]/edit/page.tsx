import { renderGoalsPage } from '../../goals-page'

export default async function EditGoalPage({ params }: { params: Promise<{ id: string }> }) {
  return renderGoalsPage({ id: (await params).id })
}
