import type { LucideIcon } from 'lucide-react'
import styles from './SectionHeading.module.scss'

export type SectionHeadingProps = {
  icon: LucideIcon
  title: string
  subtitle?: string
  id?: string
  level?: 2 | 3
  className?: string
  inline?: boolean
}

export function SectionHeading({
  icon: Icon,
  title,
  subtitle,
  id,
  level = 2,
  className,
  inline = false,
}: SectionHeadingProps) {
  const Heading = level === 2 ? 'h2' : 'h3'
  const content = (
    <>
      <span className={styles.icon} aria-hidden="true">
        <Icon size={20} strokeWidth={2} focusable="false" />
      </span>
      {inline ? (
        <span className={styles.copy}>
          <span id={id} role="heading" aria-level={level} className={styles.title}>
            {title}
          </span>
          {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
        </span>
      ) : (
        <div className={styles.copy}>
          <Heading id={id} className={styles.title}>
            {title}
          </Heading>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </div>
      )}
    </>
  )
  const classes = [styles.heading, className].filter(Boolean).join(' ')
  return inline ? (
    <span className={classes}>{content}</span>
  ) : (
    <div className={classes}>{content}</div>
  )
}
