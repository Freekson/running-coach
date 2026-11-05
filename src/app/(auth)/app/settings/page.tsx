import { PendingSection } from '../pending-section'
import { renderProtectedPage } from '../protected-page'

export default async function SettingsPage() {
  return renderProtectedPage(
    <PendingSection
      title="Settings"
      description="Account settings will be available here later."
    />,
  )
}
