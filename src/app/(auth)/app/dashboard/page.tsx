import { renderProtectedPage } from '../protected-page'
import { EmptyState } from '@/components/ui/States'

export default async function DashboardPage() {
  return renderProtectedPage(
    <section className="app-page">
      <h1>Dashboard</h1>
      <EmptyState
        title="Your training space is ready"
        description="Training insights will appear here later."
      />
    </section>,
  )
}
