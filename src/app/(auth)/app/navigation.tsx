'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import type { UserRole } from '@prisma/client'
import { useRef, useState } from 'react'
import {
  ChevronDown,
  Dumbbell,
  Heart,
  History,
  LayoutDashboard,
  Settings,
  Shield,
  Target,
} from 'lucide-react'
import { useNavigationGuard } from './navigation-guard'
import styles from './app-shell.module.scss'

const sections = [
  { label: 'Dashboard', href: '/app/dashboard', icon: LayoutDashboard },
  { label: 'Training', href: '/app/training', icon: Dumbbell },
  { label: 'Health', href: '/app/health', icon: Heart },
  { label: 'Settings', href: '/app/settings', icon: Settings },
] as const

function TrainingNavigation({ pathname }: { pathname: string }) {
  const active =
    pathname === '/app/training' ||
    pathname.startsWith('/app/training/') ||
    pathname === '/app/goals' ||
    pathname.startsWith('/app/goals/')
  const [expanded, setExpanded] = useState(active)
  const trigger = useRef<HTMLButtonElement>(null)
  const router = useRouter()
  const { requestLeave } = useNavigationGuard()
  return (
    <div
      className={styles.trainingGroup}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && expanded) {
          event.preventDefault()
          setExpanded(false)
          trigger.current?.focus()
        }
      }}
    >
      <button
        type="button"
        ref={trigger}
        className={styles.navLink}
        data-active={active || undefined}
        aria-expanded={expanded}
        aria-controls="training-navigation"
        onClick={() => setExpanded(!expanded)}
      >
        <Dumbbell size={20} strokeWidth={2} aria-hidden="true" focusable="false" />
        <span>Training</span>
        <ChevronDown
          className={styles.trainingChevron}
          size={16}
          strokeWidth={2}
          aria-hidden="true"
          focusable="false"
        />
      </button>
      <div
        id="training-navigation"
        className={styles.trainingSubmenu}
        data-expanded={expanded}
        aria-hidden={!expanded}
        inert={!expanded}
      >
        <div className={styles.trainingSubmenuContent}>
          <div className={styles.trainingSubmenuLinks}>
            {[
              { label: 'Goals', href: '/app/goals', icon: Target },
              { label: 'History', href: '/app/training', icon: History },
            ].map(({ label, href, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={styles.navLink}
                aria-current={
                  pathname === href || pathname.startsWith(`${href}/`) ? 'page' : undefined
                }
                onNavigate={(event) => {
                  if (pathname !== href && requestLeave(() => router.push(href)))
                    event.preventDefault()
                }}
              >
                <Icon size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
                <span>{label}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export function AppNavigation({ role }: { role: UserRole }) {
  const pathname = usePathname()
  const router = useRouter()
  const { requestLeave } = useNavigationGuard()
  const links =
    role === 'ADMIN'
      ? [...sections, { label: 'Admin', href: '/app/admin', icon: Shield }]
      : sections

  return (
    <nav className={styles.navigation} aria-label="App navigation">
      {links.map(({ label, href, icon: Icon }) =>
        href === '/app/training' ? (
          <TrainingNavigation key={`training-${pathname}`} pathname={pathname} />
        ) : (
          <Link
            key={href}
            href={href}
            className={[styles.navLink, href === '/app/admin' && styles.adminLink]
              .filter(Boolean)
              .join(' ')}
            aria-current={pathname === href || pathname.startsWith(`${href}/`) ? 'page' : undefined}
            onNavigate={(event) => {
              if (pathname !== href && requestLeave(() => router.push(href))) event.preventDefault()
            }}
          >
            <Icon size={20} strokeWidth={2} aria-hidden="true" focusable="false" />
            <span>{label}</span>
          </Link>
        ),
      )}
    </nav>
  )
}
