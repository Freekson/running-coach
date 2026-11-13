import { DashboardSkeleton } from './dashboard-skeleton'
import { renderProtectedPage } from '../protected-page'

export default async function DashboardLoading() {
  return renderProtectedPage(<DashboardSkeleton />)
}
