import type { ComponentPropsWithoutRef } from 'react'
import styles from './FormField.module.scss'

export type InputProps = ComponentPropsWithoutRef<'input'>

export function Input({ className, ...props }: InputProps) {
  return <input {...props} className={['field', className].filter(Boolean).join(' ')} />
}

export type FormFieldProps = Omit<InputProps, 'id' | 'aria-invalid' | 'aria-describedby'> & {
  id: string
  label: string
  hint?: string
  error?: string
}

export function FormField({ id, label, hint, error, ...inputProps }: FormFieldProps) {
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ')

  return (
    <div className={styles.fieldGroup}>
      <label htmlFor={id}>{label}</label>
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
        <span className={styles.error} id={`${id}-error`}>
          {error}
        </span>
      )}
    </div>
  )
}
