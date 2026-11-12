'use client'

import { useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import type { UserRole } from '@prisma/client'
import { ChevronRight, Shield, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { SignOutButton } from '../sign-out-button'
import { useNavigationGuard } from './navigation-guard'
import styles from './app-shell.module.scss'

export function MobileAccountMenu({
  identity,
  initial,
  role,
}: {
  identity: string
  initial: string
  role: UserRole
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const headingId = useId()
  const pathname = usePathname()
  const router = useRouter()
  const { requestLeave } = useNavigationGuard()

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        root.current?.querySelector<HTMLButtonElement>('button[aria-controls]')?.focus()
      }
    }
    const onPopState = () => setOpen(false)
    const desktop = window.matchMedia('(min-width: 769px)')
    const onBreakpointChange = () => {
      if (desktop.matches) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('popstate', onPopState)
    desktop.addEventListener('change', onBreakpointChange)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('popstate', onPopState)
      desktop.removeEventListener('change', onBreakpointChange)
    }
  }, [open])

  return (
    <div
      className={styles.mobileAccount}
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
    >
      <Button
        variant="secondary"
        size="compact"
        className={styles.accountTrigger}
        aria-label="Account"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((previous) => !previous)}
      >
        <UserRound size={20} strokeWidth={2} aria-hidden="true" focusable="false" />
      </Button>
      <div
        id={panelId}
        className={styles.accountPopover}
        hidden={!open}
        role="region"
        aria-labelledby={headingId}
      >
        <div className={styles.popoverIdentity}>
          <span className={styles.avatar} aria-hidden="true">
            {initial}
          </span>
          <div>
            <p id={headingId} className={styles.popoverName}>
              {identity}
            </p>
            <p className={styles.accountLabel}>Signed in</p>
          </div>
        </div>
        {role === 'ADMIN' && (
          <Link
            href="/app/admin"
            className={styles.accountMenuLink}
            aria-current={
              pathname === '/app/admin' || pathname.startsWith('/app/admin/') ? 'page' : undefined
            }
            onNavigate={(event) => {
              setOpen(false)
              if (pathname !== '/app/admin' && requestLeave(() => router.push('/app/admin')))
                event.preventDefault()
            }}
          >
            <Shield size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
            <span>Admin</span>
            <ChevronRight size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
          </Link>
        )}
        <div className={styles.accountMenuSignOut}>
          <SignOutButton className={styles.accountMenuButton} showIcon />
        </div>
      </div>
    </div>
  )
}
