import { renderProtectedPage } from '../protected-page'
import { HealthSkeleton } from './health-skeleton'

export default async function HealthLoading() {
  return renderProtectedPage(<HealthSkeleton />)
}
