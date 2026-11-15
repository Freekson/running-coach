import { renderProtectedPage } from '../protected-page'
import { WorkoutBuilder } from '@/components/workouts/WorkoutBuilder'

export default async function WorkoutsPage() {
  return renderProtectedPage(
    <main>
      <h1>Workouts</h1>
      <WorkoutBuilder />
    </main>,
  )
}
