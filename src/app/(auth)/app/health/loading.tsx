import { LoadingState } from '@/components/ui/States'
import { renderProtectedPage } from '../protected-page'
import styles from './health-page.module.scss'

export default async function HealthLoading() {
  return renderProtectedPage(
    <main className={styles.loadingPage}>
      <header className={styles.header}>
        <div>
          <h1>Health &amp; Recovery</h1>
          <p>Your recovery trends and Garmin health data.</p>
        </div>
      </header>
      <div className={styles.loadingIndicator}>
        <LoadingState label="Loading health data…" size="large" />
      </div>
    </main>,
  )
}
