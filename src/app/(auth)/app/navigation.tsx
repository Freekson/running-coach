'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import type { UserRole } from '@prisma/client'
import { useNavigationGuard } from './navigation-guard'
import styles from './app-shell.module.scss'

const sections = [
  { label: 'Dashboard', href: '/app/dashboard' },
  { label: 'Training', href: '/app/training' },
  { label: 'Calendar', href: '/app/calendar' },
  { label: 'Goals', href: '/app/goals' },
  { label: 'Settings', href: '/app/settings' },
] as const

export function AppNavigation({ role }: { role: UserRole }) {
  const pathname = usePathname()
  const router = useRouter()
  const { requestLeave } = useNavigationGuard()
  const links = role === 'ADMIN' ? [...sections, { label: 'Admin', href: '/app/admin' }] : sections

  return (
    <nav className={styles.navigation} aria-label="App navigation">
      {links.map(({ label, href }) => (
        <Link
          key={href}
          href={href}
          className={styles.navLink}
          aria-current={pathname === href || pathname.startsWith(`${href}/`) ? 'page' : undefined}
          onNavigate={(event) => {
            if (pathname !== href && requestLeave(() => router.push(href))) event.preventDefault()
          }}
        >
          {label}
        </Link>
      ))}
    </nav>
  )
}
