import type { HTMLAttributes } from 'react'

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: 'neutral' | 'success' | 'warning' | 'error'
}

export function Badge({ tone = 'neutral', className, ...props }: BadgeProps) {
  return (
    <span
      {...props}
      className={['badge', tone !== 'neutral' && `badge--${tone}`, className]
        .filter(Boolean)
        .join(' ')}
    />
  )
}
