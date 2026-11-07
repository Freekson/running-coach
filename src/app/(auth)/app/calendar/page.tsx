import { PendingSection } from '../pending-section'
import { renderProtectedPage } from '../protected-page'

export default async function CalendarPage() {
  return renderProtectedPage(
    <PendingSection title="Calendar" description="Scheduled workouts will appear here later." />,
  )
}
