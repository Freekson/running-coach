'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  Suspense,
  type ReactNode,
} from 'react'
import { useSearchParams } from 'next/navigation'
import { CircleCheck, CircleX, Info, TriangleExclamationPoint, X } from 'lucide-react'
import { redirectNotice, type ToastTone } from './toast-redirect'
import styles from './Toast.module.scss'

export type ToastMessage = { id: number; tone: ToastTone; message: string }
type Notify = (tone: ToastTone, message: string) => void

const ToastContext = createContext<Notify | null>(null)
const toneIcons = {
  success: CircleCheck,
  error: CircleX,
  warning: TriangleExclamationPoint,
  info: Info,
} as const

function RedirectNoticeConsumer({ notify }: { notify: Notify }) {
  const searchParams = useSearchParams()
  const query = searchParams?.toString() ?? ''

  useEffect(() => {
    const url = new URL(window.location.href)
    const codes = url.searchParams.getAll('notice')
    if (!codes.length) return
    url.searchParams.delete('notice')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
    if (codes.length !== 1) return
    const notice = redirectNotice(codes[0])
    if (notice) notify(notice.tone, notice.message)
  }, [query, notify])

  return null
}

export function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastMessage[]
  onDismiss: (id: number) => void
}) {
  return (
    <div className={styles.viewport} aria-label="Notifications">
      {toasts.map((toast) => {
        const ToneIcon = toneIcons[toast.tone]
        return (
          <div
            key={toast.id}
            data-toast-id={toast.id}
            className={`${styles.toast} ${styles[toast.tone]}`}
            role={toast.tone === 'error' || toast.tone === 'warning' ? 'alert' : 'status'}
          >
            <ToneIcon
              className={styles.icon}
              size={20}
              strokeWidth={2}
              aria-hidden="true"
              focusable="false"
            />
            <span className={styles.message}>{toast.message}</span>
            <button
              type="button"
              className={styles.dismiss}
              aria-label={`Dismiss notification: ${toast.message}`}
              onClick={(event) => {
                const focused = document.activeElement === event.currentTarget
                const buttons = Array.from(
                  event.currentTarget.parentElement?.parentElement?.querySelectorAll('button') ??
                    [],
                )
                const index = buttons.indexOf(event.currentTarget)
                const next = buttons[index + 1] ?? buttons[index - 1]
                onDismiss(toast.id)
                if (focused) {
                  if (next) next.focus()
                  else document.getElementById('main-content')?.focus()
                }
              }}
            >
              <X size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const nextId = useRef(0)
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer) clearTimeout(timer)
    timers.current.delete(id)
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const notify = useCallback<Notify>(
    (tone, message) => {
      const id = ++nextId.current
      const focusedId = Number(
        document.activeElement?.closest('[data-toast-id]')?.getAttribute('data-toast-id'),
      )
      setToasts((current) => {
        const next = [...current, { id, tone, message }]
        if (next.length <= 3) return next
        const removableIndex = next.findIndex((item) => item.id !== focusedId)
        return next.filter((_, index) => index !== removableIndex)
      })
      function schedule(delay: number) {
        timers.current.set(
          id,
          setTimeout(() => {
            const element = document.querySelector(`[data-toast-id="${id}"]`)
            if (element?.contains(document.activeElement)) schedule(1000)
            else dismiss(id)
          }, delay),
        )
      }
      schedule(tone === 'error' || tone === 'warning' ? 8000 : 5000)
    },
    [dismiss],
  )

  useEffect(() => {
    const activeTimers = timers.current
    return () => {
      for (const timer of activeTimers.values()) clearTimeout(timer)
      activeTimers.clear()
    }
  }, [])

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <Suspense fallback={null}>
        <RedirectNoticeConsumer notify={notify} />
      </Suspense>
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

/** Call inside ToastProvider to show a transient success or error notification. */
export function useToast(): Notify {
  const notify = useContext(ToastContext)
  if (!notify) throw new Error('useToast requires ToastProvider')
  return notify
}
