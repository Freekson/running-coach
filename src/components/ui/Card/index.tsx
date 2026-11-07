import type { HTMLAttributes } from 'react'

export type CardProps = HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'article' | 'section'
  variant?: 'default' | 'raised'
}

export function Card({ as: Element = 'div', variant = 'default', className, ...props }: CardProps) {
  return (
    <Element
      {...props}
      className={['card', variant === 'raised' && 'card--raised', className]
        .filter(Boolean)
        .join(' ')}
    />
  )
}
