import { ActivityHistorySkeleton } from './activity-history-skeleton'
import { renderProtectedPage } from '../protected-page'
import styles from './training.module.scss'

export default async function TrainingLoading() {
  return renderProtectedPage(
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>Activity History</h1>
          <p>Browse and filter your imported workouts.</p>
        </div>
      </header>
      <ActivityHistorySkeleton />
    </main>,
  )
}
