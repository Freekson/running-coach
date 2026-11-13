import { Card } from '@/components/ui/Card'
import styles from './dashboard.module.scss'
import skeleton from './dashboard-skeleton.module.scss'

function TitleSkeleton() {
  return (
    <div className={skeleton.title}>
      <span className={skeleton.icon} />
      <span className={skeleton.line} />
    </div>
  )
}

/** Match the overview layout without fetching data or rendering interactive controls. */
export function DashboardSkeleton() {
  return (
    <main className={`app-page ${styles.page}`} aria-label="Dashboard" aria-busy="true">
      <span role="status" className={skeleton.visuallyHidden}>
        Loading your training overview…
      </span>
      <div className={`${styles.page} ${skeleton.content}`} aria-hidden="true">
        <header className={skeleton.header}>
          <span className={skeleton.date} />
          <span className={skeleton.greeting} />
          <span className={skeleton.subtitle} />
        </header>
        <div className={styles.overviewGrid}>
          <Card className={styles.summary}>
            <div className={`${styles.period} ${skeleton.period}`}>
              <span className={skeleton.line} />
              <span className={skeleton.line} />
            </div>
            <div className={styles.metrics}>
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index}>
                  <span className={skeleton.metricIcon} />
                  <span className={skeleton.value} />
                  <span className={skeleton.line} />
                </div>
              ))}
            </div>
          </Card>
          <Card className={styles.card}>
            <div className={styles.cardHeader}>
              <TitleSkeleton />
              <span className={skeleton.control} />
            </div>
            <span className={skeleton.subtitle} />
            <div className={skeleton.chart}>
              {Array.from({ length: 8 }, (_, index) => (
                <span key={index} className={skeleton.column}>
                  <span className={skeleton.bar} />
                  <span className={skeleton.line} />
                </span>
              ))}
            </div>
            <span className={skeleton.line} />
          </Card>
          <Card className={`${styles.card} ${styles.next}`}>
            <TitleSkeleton />
            <div className={styles.empty}>
              <span className={skeleton.icon} />
              <span className={skeleton.subtitle} />
              <span className={skeleton.line} />
              <span className={skeleton.subtitle} />
            </div>
          </Card>
        </div>
        <div className={styles.detailsGrid}>
          <Card className={styles.card}>
            <div className={styles.cardHeader}>
              <TitleSkeleton />
              <span className={skeleton.shortLine} />
            </div>
            <div className={styles.activities}>
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index} className={styles.activity}>
                  <span className={`${skeleton.icon} ${skeleton.activityIcon}`} />
                  <div className={skeleton.activityCopy}>
                    <span className={skeleton.line} />
                    <span className={skeleton.shortLine} />
                  </div>
                  <div className={`${styles.activityMetrics} ${skeleton.activityMetrics}`}>
                    {Array.from({ length: 4 }, (_, metric) => (
                      <span key={metric} className={skeleton.line} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Card>
          <Card className={`${styles.card} ${skeleton.health}`}>
            <TitleSkeleton />
            <div className={skeleton.healthMetrics}>
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index}>
                  <span className={skeleton.line} />
                  <span className={skeleton.value} />
                </div>
              ))}
            </div>
            <span className={skeleton.line} />
          </Card>
        </div>
        <Card className={`${styles.card} ${styles.cardHeader}`}>
          <TitleSkeleton />
          <span className={skeleton.control} />
        </Card>
      </div>
    </main>
  )
}
