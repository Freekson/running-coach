import { LoadingState } from '@/components/ui/States'
import styles from './calendar.module.scss'

export function CalendarLoading() {
  return (
    <main>
      <h1 className={styles.title}>Training calendar</h1>
      <LoadingState label="Loading your training calendar…" />
    </main>
  )
}
