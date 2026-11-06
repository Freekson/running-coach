'use client'

import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button } from './Button'
import styles from './Dialog.module.scss'

export type DialogProps = {
  open: boolean
  title: string
  description?: string
  icon?: ReactNode
  iconTone?: 'neutral' | 'success' | 'error'
  size?: 'default' | 'wide'
  children: ReactNode
  actions?: ReactNode
  onClose: () => void
  pending?: boolean
}

export function Dialog({
  open,
  title,
  description,
  icon,
  iconTone = 'neutral',
  size = 'default',
  children,
  actions,
  onClose,
  pending = false,
}: DialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
    return () => {
      if (element.open) element.close()
    }
  }, [open])
  return (
    <dialog
      ref={dialog}
      className={[styles.dialog, size === 'wide' && styles.wide].filter(Boolean).join(' ')}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      aria-busy={pending || undefined}
      onCancel={(event) => {
        event.preventDefault()
        if (!pending) onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onClose()
      }}
    >
      <div className={styles.content}>
        <header className={styles.header}>
          <div className={styles.titleGroup}>
            {icon && (
              <span
                className={[
                  styles.titleIcon,
                  iconTone === 'success' && styles.titleIconSuccess,
                  iconTone === 'error' && styles.titleIconError,
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-hidden="true"
              >
                {icon}
              </span>
            )}
            <h2 id={titleId}>{title}</h2>
          </div>
          <Button
            variant="secondary"
            size="compact"
            className={styles.close}
            aria-label="Close dialog"
            disabled={pending}
            onClick={onClose}
          >
            <X size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
          </Button>
        </header>
        {description && (
          <p id={descriptionId} className={styles.description}>
            {description}
          </p>
        )}
        {children && <div>{children}</div>}
        {actions && <footer className={styles.actions}>{actions}</footer>}
      </div>
    </dialog>
  )
}

export type ConfirmDialogProps = Omit<DialogProps, 'children' | 'actions'> & {
  confirmText: string
  onConfirm: () => void
  variant?: 'neutral' | 'destructive'
}

export function ConfirmDialog({
  confirmText,
  onConfirm,
  variant = 'neutral',
  ...props
}: ConfirmDialogProps) {
  return (
    <Dialog
      {...props}
      actions={
        <>
          <Button variant="secondary" onClick={props.onClose} disabled={props.pending}>
            Cancel
          </Button>
          <Button
            className={variant === 'destructive' ? styles.destructive : undefined}
            onClick={onConfirm}
            loading={props.pending}
          >
            {confirmText}
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  )
}
