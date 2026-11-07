import type { ComponentPropsWithoutRef } from 'react'
import styles from './FormField.module.scss'

export type InputProps = ComponentPropsWithoutRef<'input'>

export function Input({ className, ...props }: InputProps) {
  return <input {...props} className={['field', className].filter(Boolean).join(' ')} />
}

export type FormFieldProps = Omit<InputProps, 'id' | 'aria-invalid' | 'aria-describedby'> & {
  id: string
  label: string
  optional?: boolean
  hint?: string
  error?: string
}

export function FormField({
  id,
  label,
  optional = false,
  hint,
  error,
  ...inputProps
}: FormFieldProps) {
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ')

  return (
    <div className={styles.fieldGroup}>
      <label htmlFor={id}>
        {label}
        {optional && (
          <>
            {' '}
            <span className={styles.optional}>(optional)</span>
          </>
        )}
      </label>
      {hint && (
        <span className={styles.hint} id={`${id}-hint`}>
          {hint}
        </span>
      )}
      <Input
        {...inputProps}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
      />
      {error && (
        <span className={styles.error} id={`${id}-error`} role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
