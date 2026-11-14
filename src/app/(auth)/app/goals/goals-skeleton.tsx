import { Card } from '@/components/ui/Card'
import page from './goals.module.scss'
import styles from './goals-skeleton.module.scss'

export function GoalsSkeleton() {
  return (
    <main className={page.screen} aria-label="Goals" aria-busy="true">
      <span className={page.srOnly} role="status">
        Loading goals…
      </span>
      <div className={styles.content} aria-hidden="true">
        <header className={page.header}>
          <div className={styles.pageHeading}>
            <span className={styles.title} />
            <span className={styles.subtitle} />
          </div>
          <span className={styles.action} />
        </header>
        <div className={`${page.tabs} ${styles.tabs}`}>
          <span className={styles.line} />
          <span className={styles.shortLine} />
          <span className={styles.shortLine} />
        </div>
        <div className={page.toolbar}>
          <span className={styles.shortLine} />
          <div className={`${page.typeFilter} ${styles.filter}`}>
            <span className={styles.shortLine} />
            <span className={styles.action} />
          </div>
        </div>
        <div className={page.grid}>
          {Array.from({ length: 3 }, (_, index) => (
            <Card key={index} className={`${page.goalCard} ${styles.card}`}>
              <div className={page.cardHeader}>
                <span className={styles.icon} />
                <div className={styles.cardHeading}>
                  <span className={styles.line} />
                  <span className={styles.shortLine} />
                </div>
                <span className={styles.badge} />
              </div>
              <div className={page.metric}>
                <span className={styles.value} />
                <span className={styles.shortLine} />
              </div>
              <div className={page.metadata}>
                <span className={styles.line} />
                <span className={styles.shortLine} />
              </div>
              <div className={`${page.cardActions} ${styles.cardActions}`}>
                <span className={styles.line} />
                <span className={styles.shortLine} />
                <span className={styles.shortLine} />
              </div>
            </Card>
          ))}
        </div>
      </div>
    </main>
  )
}
