import styles from './training.module.scss'
import { Card } from '@/components/ui/Card'

export function ActivityTableHead() {
  return (
    <thead>
      <tr>
        {['Date', 'Activity', 'Distance', 'Duration', 'Pace / speed', 'Avg HR'].map((label) => (
          <th key={label} scope="col">
            {label}
          </th>
        ))}
      </tr>
    </thead>
  )
}

export function ActivityHistorySkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <Card className={styles.history} aria-busy="true">
      <span role="status" className={styles.visuallyHidden}>
        Loading activities…
      </span>
      <div className={styles.filters} aria-hidden="true">
        <h2>Activities</h2>
        <div className={styles.filterFields}>
          {Array.from({ length: 3 }, (_, index) => (
            <span key={index} className={styles.skeletonControl} />
          ))}
        </div>
      </div>
      <table className={styles.table}>
        <caption className={styles.visuallyHidden}>Imported activity history.</caption>
        <ActivityTableHead />
        <tbody>
          <ActivitySkeletonRows rows={rows} />
        </tbody>
      </table>
    </Card>
  )
}

export function ActivitySkeletonRows({ rows }: { rows: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, index) => (
        <tr key={index} aria-hidden="true" className={styles.skeletonRow} data-skeleton-row>
          <td className={styles.date}>
            <span className={styles.skeletonLine} />
          </td>
          <th scope="row" className={styles.activityName}>
            <span className={`${styles.sportIcon} ${styles.skeletonIcon}`} />
            <span>
              <span className={styles.skeletonLine} />
              <small>
                <span className={styles.skeletonLine} />
              </small>
            </span>
          </th>
          <td>
            <span className={styles.skeletonLine} />
          </td>
          <td>
            <span className={styles.skeletonLine} />
            <small>
              <span className={styles.skeletonLine} />
            </small>
          </td>
          <td>
            <span className={styles.skeletonLine} />
          </td>
          <td>
            <span className={styles.skeletonLine} />
          </td>
        </tr>
      ))}
    </>
  )
}
