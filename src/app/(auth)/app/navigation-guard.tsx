'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from 'react'

type Blocker = (proceed: () => void) => void
type NavigationGuard = {
  registerBlocker: (blocker: Blocker) => () => void
  requestLeave: (proceed: () => void) => boolean
}

const NavigationGuardContext = createContext<NavigationGuard>({
  registerBlocker: () => () => {},
  requestLeave: () => false,
})

const historyBaseKey = '__runningCoachUnsavedChangesBase'

function isBaseEntry(state: unknown, token: string) {
  return !!state && typeof state === 'object' && Reflect.get(state, historyBaseKey) === token
}

function navigationIndex() {
  const navigation = (window as Window & { navigation?: { currentEntry?: { index: number } } })
    .navigation
  return navigation?.currentEntry?.index
}

export function NavigationGuardProvider({ children }: { children: ReactNode }) {
  const guardToken = useId()
  const blocker = useRef<Blocker | null>(null)
  const guardActive = useRef(false)
  const baseIndex = useRef<number | undefined>(undefined)
  const restoring = useRef<{ steps: number; direction: 1 | -1 } | null>(null)

  const releaseHistoryGuard = useCallback(() => {
    blocker.current = null
    if (!guardActive.current) return
    guardActive.current = false
    const state = window.history.state
    if (isBaseEntry(state, guardToken)) {
      const nextState = { ...state }
      delete nextState[historyBaseKey]
      window.history.replaceState(nextState, '', window.location.href)
    }
  }, [guardToken])

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const pendingRestore = restoring.current
      if (pendingRestore) {
        event.stopImmediatePropagation()
        pendingRestore.steps += 1
        if (isBaseEntry(event.state, guardToken)) {
          restoring.current = null
          blocker.current?.(() => {
            releaseHistoryGuard()
            window.history.go(-pendingRestore.direction * pendingRestore.steps)
          })
        } else {
          window.history.go(pendingRestore.direction)
        }
        return
      }
      if (!guardActive.current || !blocker.current || isBaseEntry(event.state, guardToken)) return
      // Restore the current entry before asking whether the user wants to leave.
      // This keeps browser history intact, including Forward after a clean save.
      event.stopImmediatePropagation()
      const currentIndex = navigationIndex()
      const direction: 1 | -1 =
        currentIndex !== undefined &&
        baseIndex.current !== undefined &&
        currentIndex > baseIndex.current
          ? -1
          : 1
      restoring.current = { steps: 0, direction }
      window.history.go(direction)
    }
    window.addEventListener('popstate', onPopState, { capture: true })
    return () => window.removeEventListener('popstate', onPopState, { capture: true })
  }, [guardToken, releaseHistoryGuard])

  const registerBlocker = useCallback(
    (next: Blocker) => {
      blocker.current = next
      if (!guardActive.current) {
        const state = window.history.state
        window.history.replaceState(
          { ...(state && typeof state === 'object' ? state : {}), [historyBaseKey]: guardToken },
          '',
          window.location.href,
        )
        baseIndex.current = navigationIndex()
        guardActive.current = true
      }
      return () => {
        if (blocker.current === next) releaseHistoryGuard()
      }
    },
    [guardToken, releaseHistoryGuard],
  )
  const requestLeave = useCallback(
    (proceed: () => void) => {
      if (!blocker.current) return false
      blocker.current(() => {
        releaseHistoryGuard()
        proceed()
      })
      return true
    },
    [releaseHistoryGuard],
  )

  return (
    <NavigationGuardContext.Provider value={{ registerBlocker, requestLeave }}>
      {children}
    </NavigationGuardContext.Provider>
  )
}

export function useNavigationGuard() {
  return useContext(NavigationGuardContext)
}
