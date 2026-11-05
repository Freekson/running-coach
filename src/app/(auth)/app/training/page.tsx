import { PendingSection } from '../pending-section'
import { renderProtectedPage } from '../protected-page'

export default async function TrainingPage() {
  return renderProtectedPage(
    <PendingSection title="Training" description="Training plans will appear here later." />,
  )
}
