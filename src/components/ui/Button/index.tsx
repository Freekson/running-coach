import Link from 'next/link'
import type { ComponentProps, ComponentPropsWithoutRef } from 'react'

type ButtonStyleProps = {
  variant?: 'primary' | 'secondary'
  size?: 'default' | 'compact'
  className?: string
}

function buttonClasses({ variant = 'primary', size = 'default', className }: ButtonStyleProps) {
  return [
    'button',
    variant === 'secondary' && 'button--secondary',
    size === 'compact' && 'button--compact',
    className,
  ]
    .filter(Boolean)
    .join(' ')
}

export type ButtonProps = ComponentPropsWithoutRef<'button'> &
  ButtonStyleProps & { loading?: boolean }

export function Button({
  variant,
  size,
  className,
  loading = false,
  disabled,
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={buttonClasses({ variant, size, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading && <span className="button__spinner" aria-hidden="true" />}
      {children}
    </button>
  )
}

export type ButtonLinkProps = Omit<ComponentProps<typeof Link>, 'aria-disabled'> &
  ButtonStyleProps & { disabled?: boolean }

export function ButtonLink({
  variant,
  size,
  className,
  disabled = false,
  children,
  ...props
}: ButtonLinkProps) {
  const classes = buttonClasses({ variant, size, className })

  if (disabled) {
    return (
      <span
        id={props.id}
        title={props.title}
        role="link"
        aria-label={props['aria-label']}
        aria-labelledby={props['aria-labelledby']}
        aria-describedby={props['aria-describedby']}
        aria-disabled="true"
        className={classes}
      >
        {children}
      </span>
    )
  }

  return (
    <Link {...props} className={classes}>
      {children}
    </Link>
  )
}
