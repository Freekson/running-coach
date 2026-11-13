import { Card } from '@/components/ui/Card'
import { renderProtectedPage } from '../../protected-page'
import styles from './activity-detail.module.scss'

export default async function ActivityDetailLoading() {
  return renderProtectedPage(
    <main className={styles.page}>
      <h1>Activity details</h1>
      <Card className={styles.loadingCharts} aria-busy="true">
        <p role="status">Loading saved activity…</p>
        <div className={styles.chartSkeleton} />
      </Card>
    </main>,
  )
}
