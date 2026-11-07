'use client'

import {
  useEffect,
  useId,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { X } from 'lucide-react'
import { Button } from '../Button'
import styles from './Dialog.module.scss'

export type DialogProps = {
  open: boolean
  title: string
  description?: string
  icon?: ReactNode
  iconTone?: 'neutral' | 'success' | 'error'
  size?: 'default' | 'wide'
  className?: string
  children: ReactNode
  actions?: ReactNode
  onClose: () => void
  pending?: boolean
}

type ScrollLock = {
  count: number
  bodyOverflow: string
  rootOverflow: string
}

const scrollLocks = new WeakMap<Document, ScrollLock>()

function lockBackgroundScroll(ownerDocument: Document) {
  const current = scrollLocks.get(ownerDocument)
  if (current) {
    current.count += 1
  } else {
    scrollLocks.set(ownerDocument, {
      count: 1,
      bodyOverflow: ownerDocument.body.style.overflow,
      rootOverflow: ownerDocument.documentElement.style.overflow,
    })
    ownerDocument.body.style.overflow = 'hidden'
    ownerDocument.documentElement.style.overflow = 'hidden'
  }

  return () => {
    const lock = scrollLocks.get(ownerDocument)
    if (!lock) return
    lock.count -= 1
    if (lock.count > 0) return
    ownerDocument.body.style.overflow = lock.bodyOverflow
    ownerDocument.documentElement.style.overflow = lock.rootOverflow
    scrollLocks.delete(ownerDocument)
  }
}

export function Dialog({
  open,
  title,
  description,
  icon,
  iconTone = 'neutral',
  size = 'default',
  className,
  children,
  actions,
  onClose,
  pending = false,
}: DialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const pointerStartedOnBackdrop = useRef(false)
  const titleId = useId()
  const descriptionId = useId()
  function isBackdropPointer(event: ReactPointerEvent<HTMLDialogElement>) {
    if (event.button !== 0 || event.target !== event.currentTarget) return false
    const bounds = event.currentTarget.getBoundingClientRect()
    return (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
  }
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
    const unlockScroll = open ? lockBackgroundScroll(element.ownerDocument) : undefined
    return () => {
      if (element.open) element.close()
      unlockScroll?.()
    }
  }, [open])
  return (
    <dialog
      ref={dialog}
      className={[styles.dialog, size === 'wide' && styles.wide, className]
        .filter(Boolean)
        .join(' ')}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      aria-busy={pending || undefined}
      onCancel={(event) => {
        event.preventDefault()
        if (!pending) onClose()
      }}
      onPointerDown={(event) => {
        pointerStartedOnBackdrop.current = isBackdropPointer(event)
      }}
      onPointerUp={(event) => {
        const shouldClose = pointerStartedOnBackdrop.current && isBackdropPointer(event)
        pointerStartedOnBackdrop.current = false
        if (shouldClose && !pending) onClose()
      }}
      onPointerCancel={() => {
        pointerStartedOnBackdrop.current = false
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
