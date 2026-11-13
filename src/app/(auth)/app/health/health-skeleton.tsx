import { Card } from '@/components/ui/Card'
import history from '@/components/health/health-history-panel.module.scss'
import weight from '../settings/athlete-settings.module.scss'
import page from './health-page.module.scss'
import styles from './health-skeleton.module.scss'

function HeadingSkeleton() {
  return (
    <div className={styles.heading}>
      <span className={styles.icon} />
      <span className={styles.line} />
    </div>
  )
}

function ChartSkeleton() {
  return (
    <>
      <div className={styles.plot} />
      <div className={styles.chartDates}>
        <span className={styles.shortLine} />
        <span className={styles.shortLine} />
      </div>
    </>
  )
}

/** Mirrors the saved-data page without loading health records or exposing active controls. */
export function HealthSkeleton() {
  return (
    <main className={`app-page ${page.page}`} aria-label="Health & Recovery" aria-busy="true">
      <span className={styles.visuallyHidden} role="status">
        Loading health data…
      </span>
      <div className={styles.content} aria-hidden="true">
        <header className={page.header}>
          <div className={styles.pageHeading}>
            <span className={styles.title} />
            <span className={styles.line} />
          </div>
          <span className={styles.action} />
        </header>
        <div className={history.history}>
          <Card className={`${history.trendCard} ${styles.card}`}>
            <HeadingSkeleton />
            <div className={styles.row}>
              <div className={styles.summary}>
                <span className={styles.value} />
                <span className={styles.line} />
              </div>
              <div className={styles.controls}>
                <span className={styles.period} />
                <span className={styles.action} />
              </div>
            </div>
            <ChartSkeleton />
            <div className={styles.legend}>
              {Array.from({ length: 4 }, (_, index) => (
                <span key={index} className={styles.shortLine} />
              ))}
            </div>
          </Card>
          <div className={history.summaryCards}>
            <Card className={`${history.heartCard} ${styles.card}`}>
              <div className={styles.row}>
                <HeadingSkeleton />
                <span className={styles.period} />
              </div>
              <div className={styles.row}>
                <span className={styles.value} />
                <div className={styles.summary}>
                  <span className={styles.shortLine} />
                  <span className={styles.value} />
                </div>
              </div>
              <ChartSkeleton />
            </Card>
            <Card className={`${history.nightCard} ${styles.card}`}>
              <HeadingSkeleton />
              <div className={styles.row}>
                <div className={styles.summary}>
                  <span className={styles.value} />
                  <span className={styles.shortLine} />
                </div>
                <span className={styles.ring} />
              </div>
              <div className={styles.times}>
                {Array.from({ length: 2 }, (_, index) => (
                  <div key={index} className={styles.summary}>
                    <span className={styles.shortLine} />
                    <span className={styles.value} />
                  </div>
                ))}
              </div>
              <span className={styles.shortLine} />
              <span className={styles.line} />
              <div className={styles.stages}>
                {Array.from({ length: 4 }, (_, index) => (
                  <div key={index} className={styles.tile}>
                    <span className={styles.shortLine} />
                    <span className={styles.value} />
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
        <Card className={`${weight.section} ${styles.card}`}>
          <div className={styles.row}>
            <HeadingSkeleton />
            <span className={styles.action} />
          </div>
          <div className={`${weight.chartCard} ${styles.card}`}>
            <div className={styles.row}>
              <span className={styles.value} />
              <span className={styles.period} />
            </div>
            <ChartSkeleton />
          </div>
          <HeadingSkeleton />
          <div className={styles.readings}>
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className={styles.tile}>
                <span className={styles.shortLine} />
                <span className={styles.value} />
                <span className={styles.shortLine} />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </main>
  )
}
