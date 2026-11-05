import { PendingSection } from '../pending-section'
import { renderProtectedPage } from '../protected-page'

export default async function GoalsPage() {
  return renderProtectedPage(
    <PendingSection title="Goals" description="Your goals will appear here later." />,
  )
}
