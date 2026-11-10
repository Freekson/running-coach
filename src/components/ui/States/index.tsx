import type { ReactNode } from 'react'
import styles from './States.module.scss'

export type EmptyStateProps = {
  title: string
  description: string
  action?: ReactNode
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className={styles.state}>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  )
}

export type LoadingStateProps = { label: string; size?: 'default' | 'large' }

export function LoadingState({ label, size = 'default' }: LoadingStateProps) {
  return (
    <div
      className={`${styles.loading} ${size === 'large' ? styles.loadingLarge : ''}`}
      role="status"
      aria-live="polite"
    >
      <span className={styles.spinner} aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}
